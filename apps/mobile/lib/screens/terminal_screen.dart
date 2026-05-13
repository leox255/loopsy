import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:xterm/xterm.dart';

import '../models/pairing.dart';
import '../services/chat_event.dart';
import '../services/relay_client.dart';
import '../services/storage.dart';
import '../theme.dart';
import '../widgets/chat_panel.dart';
import '../widgets/loopsy_modal.dart';
import '../widgets/terminal_accessory_bar.dart';

enum _ViewMode { terminal, chat }

class TerminalScreen extends StatefulWidget {
  final String sessionId;
  final String agent;
  final bool fresh;
  final bool auto;

  /// Set when [agent] is `'custom'` — id of the user-defined entry on
  /// the daemon. Sent to the daemon via session-open so the daemon can
  /// resolve it against its trusted customCommands list (the phone never
  /// sends raw argv).
  final String? customCommandId;
  const TerminalScreen({
    super.key,
    required this.sessionId,
    required this.agent,
    required this.fresh,
    this.auto = false,
    this.customCommandId,
  });

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late final Terminal _terminal = Terminal(maxLines: 10000);
  late final TerminalController _controller = TerminalController();
  final FocusNode _termFocus = FocusNode();
  RelaySession? _session;
  String _status = 'connecting…';
  bool _statusError = false;
  // First-prompt buffer for auto-summary
  final StringBuffer _firstLine = StringBuffer();
  bool _summaryCaptured = false;

  // One-shot modifiers from the accessory bar. The system soft keyboard
  // has no concept of Ctrl/Alt, so we hold the latched state here and
  // transform the very next byte the terminal emits before it leaves
  // for the PTY.
  bool _ctrlArmed = false;
  bool _altArmed = false;

  // Chat view state. The chat stream piggy-backs on the same relay
  // sessionId — terminal and chat are two renderings of one session.
  _ViewMode _view = _ViewMode.terminal;
  final ChatLog _chatLog = ChatLog();
  int _chatRevision = 0;
  bool _chatSubscribed = false;

  // Auto-reconnect state. When the relay WS drops while the user is
  // still on this screen, we transparently reopen the session so the
  // user can keep typing or sending chat without having to back out and
  // re-enter. Backoff bounds: 1s → 30s cap.
  bool _disposed = false;
  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;
  String? _cachedSudoPassword; // first-time auto-approve password

  /// Agents whose CLI writes a transcript we can tail. Claude / Gemini
  /// / Codex each have their own on-disk format; the daemon picks the
  /// right adapter on subscribe. OpenCode is excluded because it stores
  /// transcripts in a SQLite database — a separate adapter shape we
  /// haven't built yet. The daemon also fast-paths capability:unavailable
  /// for any agent without an adapter, but gating here keeps the UI
  /// clean (no "chat unavailable" placeholder users have to dismiss).
  bool get _chatSupported =>
      widget.agent == 'claude' ||
      widget.agent == 'gemini' ||
      widget.agent == 'codex';

  // Voice
  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _voiceReady = false;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final pairing = await Storage.readPairing();
    if (pairing == null) {
      if (mounted) Navigator.of(context).pop();
      return;
    }

    _terminal.onOutput = (data) {
      final raw = utf8.encode(data);
      final transformed = _applyModifiers(raw);
      _session?.sendStdin(transformed);
      _captureSummary(transformed);
    };
    _terminal.onResize = (w, h, pixelWidth, pixelHeight) =>
        _session?.resize(w, h);

    // For auto-approve sessions, gate the FIRST open behind either a
    // cached approval token or a macOS-password handshake. Subsequent
    // reconnect attempts reuse the cached password so the user isn't
    // prompted again mid-session.
    if (widget.auto) {
      final cached = await Storage.readApproveToken();
      if (cached == null) {
        if (!mounted) return;
        _cachedSudoPassword = await _askSudoPassword();
        if (_cachedSudoPassword == null) {
          if (mounted) Navigator.of(context).pop('cancelled');
          return;
        }
      }
    }

    // Order matters: bring the keyboard up *before* opening the
    // session so the PTY is created with the post-keyboard cols/rows.
    // Otherwise Claude/Codex/etc. render their prompt for the full-
    // screen size, the keyboard pops in, SIGWINCH fires, and the
    // agent redraws on top of itself.
    _termFocus.requestFocus();
    await _waitForTerminalLayout();

    await _openSession(pairing);

    // Lazy-init speech recognition; ignore errors silently — mic just
    // becomes unavailable.
    _voiceReady = await _speech.initialize(onError: (_) {});
    if (mounted) setState(() {});
  }

  /// Build a fresh RelaySession + call session.open. Called once during
  /// bootstrap, then again from [_scheduleReconnect] on transient
  /// disconnects so the user doesn't have to back out + re-enter the
  /// screen to recover.
  Future<void> _openSession(Pairing pairing) async {
    if (_disposed) return;

    final session = RelaySession(
      pairing: pairing,
      sessionId: widget.sessionId,
      onPty: (bytes) =>
          _terminal.write(utf8.decode(bytes, allowMalformed: true)),
      onControl: _handleControl,
      onClose: (code, _) {
        if (!mounted || _disposed) return;
        // Distinguish clean close (user backed out, code 1000) from a
        // transient drop. For drops, schedule a reconnect; for clean
        // closes leave the session dead.
        final wasError = code != 1000 && code != null;
        setState(() {
          _status = wasError ? 'reconnecting…' : 'closed (${code ?? '?'})';
          _statusError = wasError;
          _session = null;
          // Reset chat subscription state so the new session re-
          // subscribes when the user is on the chat tab.
          _chatSubscribed = false;
        });
        if (wasError || code == null) {
          _scheduleReconnect(pairing);
        }
      },
    );

    // Cached approve token may have been minted on a prior connection
    // in this session — re-read each time so we never re-prompt.
    final approveToken = widget.auto ? await Storage.readApproveToken() : null;

    await session.open(
      agent: widget.agent,
      cols: _terminal.viewWidth,
      rows: _terminal.viewHeight,
      auto: widget.auto,
      approveToken: approveToken,
      // First-time password is only sent if we don't already have a
      // token. Stored locally so reconnects don't re-prompt.
      sudoPassword: (widget.auto && approveToken == null) ? _cachedSudoPassword : null,
      customCommandId: widget.customCommandId,
    );
    if (!mounted) return;
    setState(() {
      _session = session;
      _status = 'connected';
      _statusError = false;
      _reconnectAttempt = 0;
    });

    // If user was viewing chat when the connection dropped, re-subscribe
    // automatically so they don't have to toggle tabs to recover.
    if (_view == _ViewMode.chat) {
      _ensureChatSubscribed();
    }
  }

  /// Reconnect with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s…
  /// Cancelled by [dispose] so navigating away doesn't keep retrying.
  void _scheduleReconnect(Pairing pairing) {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    final delaySec = (1 << _reconnectAttempt.clamp(0, 5)).clamp(1, 30);
    _reconnectAttempt++;
    _reconnectTimer = Timer(Duration(seconds: delaySec), () async {
      if (_disposed || !mounted) return;
      try {
        await _openSession(pairing);
      } catch (_) {
        // openSession failed (e.g., daemon still down). The onClose
        // handler on the new RelaySession will fire and schedule
        // another attempt with the next backoff step.
        if (!_disposed && mounted) _scheduleReconnect(pairing);
      }
    });
  }

  /// Spin until the xterm widget reports a real viewWidth/Height. Without
  /// this, opening the session in the same microtask as initState reads
  /// the pre-layout (often zero) values and the agent boots into a 0x0
  /// PTY, which it then has to redraw on the first frame.
  Future<void> _waitForTerminalLayout() async {
    final completer = Completer<void>();
    void poll() {
      if (!mounted) {
        if (!completer.isCompleted) completer.complete();
        return;
      }
      if (_terminal.viewWidth > 0 && _terminal.viewHeight > 0) {
        completer.complete();
        return;
      }
      WidgetsBinding.instance.addPostFrameCallback((_) => poll());
    }

    WidgetsBinding.instance.addPostFrameCallback((_) => poll());
    return completer.future;
  }

  /// Inbound text control frames from the relay/daemon. We split this out
  /// so auto-approve grant/deny messages can drive UI feedback without
  /// crowding the bootstrap path.
  Future<void> _handleControl(Map<String, dynamic> msg) async {
    if (!mounted) return;
    final type = msg['type'];
    switch (type) {
      case 'chat-event':
        final payload = msg['event'];
        if (payload is Map<String, dynamic>) {
          final ev = ChatEvent.fromJson(payload);
          if (ev != null) {
            _chatLog.apply(ev);
            // Bump revision so the ChatPanel re-renders. Only setState when
            // chat is visible; otherwise just accumulate quietly so toggling
            // back doesn't replay the whole conversation as animations.
            if (_view == _ViewMode.chat) {
              setState(() => _chatRevision++);
            } else {
              _chatRevision++;
            }
          }
        }
        break;
      case 'device-disconnected':
        setState(() {
          _status = 'device disconnected';
          _statusError = true;
        });
        break;
      case 'auto-approve-granted':
        // Daemon successfully verified our sudo password and minted a token.
        // Persist it for every future auto-approve session on this pairing.
        final token = msg['token'];
        if (token is String && token.isNotEmpty) {
          await Storage.writeApproveToken(token);
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                backgroundColor: LoopsyColors.surface,
                content: Text(
                  'Auto-approve enabled. Future sessions skip the password.',
                  style: TextStyle(color: LoopsyColors.fg),
                ),
                duration: Duration(seconds: 3),
              ),
            );
          }
        }
        break;
      case 'auto-approve-denied':
        // Daemon rejected our credentials. Drop the cached token (if any)
        // so the next attempt re-prompts for the password instead of
        // looping on a stale token.
        await Storage.deleteApproveToken();
        if (mounted) {
          setState(() {
            _status = 'auto-approve denied';
            _statusError = true;
          });
          final reason = msg['message'] is String
              ? msg['message'] as String
              : 'Auto-approve denied.';
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              backgroundColor: LoopsyColors.surface,
              content: Text(
                reason,
                style: const TextStyle(color: LoopsyColors.bad),
              ),
              duration: const Duration(seconds: 4),
            ),
          );
        }
        break;
      case 'session-error':
        // Daemon rejected the session-open before any PTY was spawned —
        // most commonly because the requested agent isn't installed on
        // the laptop. Surface the reason and bounce back to the home
        // screen so the user can pick a different agent without staring
        // at a black terminal.
        if (mounted) {
          setState(() {
            _status = 'cannot start session';
            _statusError = true;
          });
          final reason =
              (msg['message'] as String?) ??
              'The Loopsy daemon rejected this session.';
          await showLoopsyDialog<void>(
            context: context,
            icon: HugeIcons.strokeRoundedAlert02,
            title: 'Cannot start session',
            subtitle: reason,
            actions: [
              LoopsyModalAction.primary('Back', () {
                Navigator.pop(context);
                if (mounted) Navigator.of(context).pop();
              }),
            ],
          );
        }
        break;
      default:
        // Unknown control frame — ignore for forward compatibility.
        break;
    }
  }

  /// Modal that asks for the macOS user password the first time a phone
  /// requests auto-approve on a given pairing. Sent over the WSS to the
  /// daemon, which validates with `dscl . -authonly` and mints a token in
  /// return so we never have to ask again.
  Future<String?> _askSudoPassword() async {
    final ctl = TextEditingController();
    bool obscure = true;
    return showLoopsyDialog<String>(
      context: context,
      icon: HugeIcons.strokeRoundedSquareLock02,
      title: 'Enable auto-approve',
      subtitle:
          'Auto-approve runs ${widget.agent} with permission prompts skipped. '
          'Enter your machine\'s macOS user password to unlock this. '
          'You\'ll only be asked once per pairing.',
      body: StatefulBuilder(
        builder: (ctx, setSt) => TextField(
          controller: ctl,
          autofocus: true,
          obscureText: obscure,
          enableSuggestions: false,
          autocorrect: false,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => Navigator.pop(context, ctl.text),
          decoration: InputDecoration(
            hintText: 'macOS password',
            hintStyle: const TextStyle(color: LoopsyColors.muted),
            filled: true,
            fillColor: LoopsyColors.surfaceAlt,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: const BorderSide(color: LoopsyColors.border),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: const BorderSide(color: LoopsyColors.border),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: const BorderSide(color: LoopsyColors.accent),
            ),
            suffixIcon: IconButton(
              icon: HugeIcon(
                icon: obscure
                    ? HugeIcons.strokeRoundedView
                    : HugeIcons.strokeRoundedViewOff,
                color: LoopsyColors.muted,
                size: 18,
              ),
              onPressed: () => setSt(() => obscure = !obscure),
              tooltip: obscure ? 'Show' : 'Hide',
            ),
          ),
          style: const TextStyle(color: LoopsyColors.fg),
        ),
      ),
      actions: [
        LoopsyModalAction.text('Cancel', () => Navigator.pop(context)),
        LoopsyModalAction.primary(
          'Enable',
          () => Navigator.pop(context, ctl.text),
        ),
      ],
    );
  }

  /// Apply latched Ctrl/Alt modifiers (one-shot) to bytes coming out of
  /// the terminal/system-keyboard. Only single-byte sequences participate
  /// in the transform — multi-byte text (paste, autocomplete) just drops
  /// the modifier and passes through, which matches what desktop terminals
  /// do when the user pastes with Ctrl held.
  List<int> _applyModifiers(List<int> bytes) {
    if (!_ctrlArmed && !_altArmed) return bytes;
    if (bytes.length == 1) {
      final b = bytes[0];
      if (_ctrlArmed) {
        setState(() => _ctrlArmed = false);
        if (b >= 0x61 && b <= 0x7a) {
          return [b - 0x60]; // ctrl+a..z -> 0x01..0x1A
        }
        if (b >= 0x41 && b <= 0x5a) return [b - 0x40]; // ctrl+A..Z -> same
        if (b == 0x5b) return [0x1b]; // ctrl+[ -> ESC
        return bytes; // ctrl + non-letter: pass through
      }
      if (_altArmed) {
        setState(() => _altArmed = false);
        return [0x1b, b]; // alt+key -> ESC prefix
      }
    }
    // Multi-byte input with a modifier armed: drop the modifier without
    // applying. Better than mangling pasted text.
    if (_ctrlArmed) setState(() => _ctrlArmed = false);
    if (_altArmed) setState(() => _altArmed = false);
    return bytes;
  }

  /// Send raw bytes straight to the PTY (no modifier transform). Used by
  /// the accessory bar — Esc/Tab/arrows are the special keys, modifiers
  /// don't compose with them in the soft-keyboard flow.
  void _sendRawBytes(List<int> bytes) {
    _session?.sendStdin(bytes);
    _captureSummary(bytes);
  }

  Future<void> _sendChatPrompt(String text) async {
    final session = _session;
    if (session == null) return;

    // Universal submit sequence verified against real PTY runs of all
    // three agents (see packages/daemon/scripts/_test-{claude,codex,
    // gemini}-input.mjs):
    //
    //   ESC[200~ <text> \n ESC[201~  +  160ms  +  \r
    //
    // The bracketed paste with an embedded LF satisfies Codex's
    // requirement that the pasted content end with a newline before
    // the subsequent Enter triggers submit. Gemini's 30ms "fast
    // return" anti-spam guard is comfortably cleared by the 160ms
    // gap before the CR. Claude accepts it as a normal pasted prompt
    // followed by Enter. One sequence, three agents, no branches.
    final body = utf8.encode(text);
    _captureSummary([...body, 0x0d]);

    const pasteStart = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // ESC[200~
    const pasteEnd = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]; // ESC[201~
    session.sendStdin([...pasteStart, ...body, 0x0a, ...pasteEnd]);
    await Future<void>.delayed(const Duration(milliseconds: 160));
    session.sendStdin([0x0d]);
  }

  /// Build a one-line summary from the first user input the session sees and
  /// persist it on SessionMeta so it shows on the home list. We append to a
  /// buffer until we see CR/LF, ignore control characters, and truncate.
  void _captureSummary(List<int> bytes) {
    if (_summaryCaptured) return;
    for (final b in bytes) {
      if (b == 0x0d || b == 0x0a) {
        final s = _firstLine.toString().trim();
        _firstLine.clear();
        if (s.isEmpty) continue;
        _summaryCaptured = true;
        Storage.updateSession(widget.sessionId, (m) => m.copyWith(summary: s));
        return;
      }
      if (b == 0x7f) {
        // backspace
        final cur = _firstLine.toString();
        _firstLine.clear();
        if (cur.isNotEmpty) _firstLine.write(cur.substring(0, cur.length - 1));
        continue;
      }
      if (b < 0x20) continue; // skip control chars (esc, ctrl-c, etc.)
      _firstLine.writeCharCode(b);
      if (_firstLine.length > 200) {
        _summaryCaptured = true;
        Storage.updateSession(
          widget.sessionId,
          (m) => m.copyWith(summary: _firstLine.toString().trim()),
        );
        return;
      }
    }
  }

  Future<void> _openVoiceSheet() async {
    if (!_voiceReady) return;
    final ctl = TextEditingController();
    final focus = FocusNode();
    bool listening = false;
    // Tracks whether the user has manually edited the text since the last
    // speech result, so we don't overwrite their edits on subsequent results.
    bool userEdited = false;
    String lastSpeech = '';
    // Auto-start guard: gate the post-frame auto-start so it only fires on
    // FIRST build, not on every rebuild. Without this, if the user cleared
    // the field after stopping the mic, the auto-start would fire again
    // and either crash the speech engine ("already listening") or fight
    // the user's typing. This was the "click mic, try to type, crash" path.
    bool autoStartFired = false;

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: LoopsyColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) {
          Future<void> startListening() async {
            // Guard against double-start: speech_to_text throws if listen() is
            // called while a session is already active.
            if (_speech.isListening) return;
            try {
              userEdited = false;
              await _speech.listen(
                onResult: (res) {
                  if (userEdited) {
                    return; // honor manual edits, stop overwriting
                  }
                  setSheet(() {
                    lastSpeech = res.recognizedWords;
                    ctl.value = TextEditingValue(
                      text: lastSpeech,
                      selection: TextSelection.collapsed(
                        offset: lastSpeech.length,
                      ),
                    );
                  });
                },
                listenOptions: stt.SpeechListenOptions(partialResults: true),
              );
              setSheet(() => listening = true);
            } catch (e) {
              // Speech can fail mid-listen (mic permission revoked, system
              // recognizer unavailable on simulator, AVAudioSession contention
              // with another app). Surface as muted state instead of crashing
              // the whole route.
              setSheet(() => listening = false);
            }
          }

          Future<void> stopListening() async {
            if (!_speech.isListening) {
              setSheet(() => listening = false);
              return;
            }
            try {
              await _speech.stop();
            } catch (_) {
              /* engine already torn down — fine */
            }
            setSheet(() => listening = false);
          }

          // Auto-start listening ONCE when the sheet first opens. Gating on a
          // flag rather than ctl.text/listening because those can flip during
          // the session and we don't want to re-arm mid-edit.
          if (!autoStartFired) {
            autoStartFired = true;
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (Navigator.of(ctx).canPop()) startListening();
            });
          }

          return Padding(
            padding: EdgeInsets.fromLTRB(
              20,
              18,
              20,
              20 + MediaQuery.of(ctx).viewInsets.bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    HugeIcon(
                      icon: listening
                          ? HugeIcons.strokeRoundedMic01
                          : HugeIcons.strokeRoundedMicOff01,
                      color: listening ? LoopsyColors.bad : LoopsyColors.muted,
                      size: 22,
                    ),
                    const SizedBox(width: 10),
                    Text(
                      listening
                          ? 'Listening… tap text to edit'
                          : (userEdited
                                ? 'Edited — review and send'
                                : 'Tap mic to start'),
                      style: const TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 16,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: ctl,
                  focusNode: focus,
                  autofocus: false,
                  minLines: 4,
                  maxLines: 8,
                  style: const TextStyle(
                    color: LoopsyColors.fg,
                    fontFamily: 'JetBrainsMono',
                    fontSize: 15,
                  ),
                  decoration: InputDecoration(
                    hintText: 'Speak now, then edit before sending…',
                    hintStyle: const TextStyle(color: LoopsyColors.muted),
                    filled: true,
                    fillColor: LoopsyColors.surfaceAlt,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: const BorderSide(color: LoopsyColors.border),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: const BorderSide(color: LoopsyColors.border),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: const BorderSide(color: LoopsyColors.accent),
                    ),
                    contentPadding: const EdgeInsets.all(14),
                  ),
                  textCapitalization: TextCapitalization.sentences,
                  onChanged: (v) {
                    // If the user typed something different from the latest
                    // speech result, lock further speech updates so we don't
                    // overwrite. Tapping the field also pauses recognition.
                    if (v != lastSpeech) {
                      userEdited = true;
                    }
                  },
                  onTap: () {
                    if (listening) stopListening();
                  },
                ),
                const SizedBox(height: 6),
                Text(
                  listening
                      ? 'Tip: pinch the text to edit — listening pauses on tap.'
                      : 'Edit freely. Tap the mic to dictate again.',
                  style: const TextStyle(
                    color: LoopsyColors.muted,
                    fontSize: 11,
                  ),
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    TextButton.icon(
                      onPressed: listening ? stopListening : startListening,
                      icon: HugeIcon(
                        icon: listening
                            ? HugeIcons.strokeRoundedStopCircle
                            : HugeIcons.strokeRoundedMic01,
                        color: LoopsyColors.fg,
                        size: 18,
                      ),
                      label: Text(listening ? 'Stop' : 'Listen'),
                    ),
                    IconButton(
                      onPressed: () {
                        ctl.clear();
                        lastSpeech = '';
                        userEdited = false;
                        setSheet(() {});
                      },
                      icon: const HugeIcon(
                        icon: HugeIcons.strokeRoundedDelete02,
                        color: LoopsyColors.muted,
                        size: 18,
                      ),
                      tooltip: 'Clear',
                    ),
                    const Spacer(),
                    TextButton(
                      onPressed: () => Navigator.pop(ctx),
                      child: const Text('Cancel'),
                    ),
                    const SizedBox(width: 8),
                    ElevatedButton.icon(
                      onPressed: ctl.text.trim().isEmpty
                          ? null
                          : () {
                              unawaited(_sendChatPrompt(ctl.text));
                              Navigator.pop(ctx);
                            },
                      icon: const HugeIcon(
                        icon: HugeIcons.strokeRoundedSent,
                        color: LoopsyColors.bg,
                        size: 18,
                      ),
                      label: const Text('Send'),
                    ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
    // Defensive: the sheet dismisses through several paths (Cancel, Send,
    // swipe-down, route pop on backgrounding). Stopping speech here is the
    // single common cleanup — wrap in try/catch since the engine may be
    // already-stopped or never started in some of those paths.
    try {
      await _speech.stop();
    } catch (_) {
      /* already stopped */
    }
    focus.dispose();
    ctl.dispose();
  }

  /// Idempotent subscribe — the daemon dedupes on its side, but we still
  /// avoid issuing a second `chat-subscribe` when the user toggles back to
  /// chat after a brief look at the terminal. Re-subscribing after a
  /// reconnect is handled by clearing this flag on session close (TODO
  /// when we add that recovery path; v1 expects one continuous session).
  void _ensureChatSubscribed() {
    if (!_chatSupported) return;
    if (_chatSubscribed) return;
    if (_session == null) return;
    _session!.sendControl({'type': 'chat-subscribe'});
    _chatSubscribed = true;
  }

  @override
  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    if (_chatSubscribed) {
      _session?.sendControl({'type': 'chat-unsubscribe'});
    }
    _session?.close();
    _termFocus.dispose();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: LoopsyColors.bg,
      appBar: AppBar(
        leading: IconButton(
          icon: const HugeIcon(
            icon: HugeIcons.strokeRoundedArrowLeft02,
            color: LoopsyColors.fg,
          ),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        // Title kept tight: agent icon + agent name. The 6-char sessionId
        // tail used to live here too, but cramming it next to the toggle
        // and the status pill caused the AppBar to overflow on iPhones
        // narrower than ~iPhone Plus. SessionId is shown on the home list
        // and isn't load-bearing while you're inside the session.
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            HugeIcon(icon: _agentIcon(), color: LoopsyColors.accent, size: 18),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                widget.agent,
                style: const TextStyle(fontFamily: 'JetBrainsMono'),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Row(
              children: [
                Text(
                  widget.sessionId.substring(0, 6),
                  style: const TextStyle(
                    color: LoopsyColors.muted,
                    fontSize: 12,
                    fontFamily: 'JetBrainsMono',
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 10),
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: _statusError ? LoopsyColors.bad : LoopsyColors.good,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  _status,
                  style: TextStyle(
                    color: _statusError ? LoopsyColors.bad : LoopsyColors.good,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      // Keep both panes mounted via IndexedStack so toggling between
      // terminal and chat is instant and the terminal keeps receiving
      // PTY output even when hidden. The accessory bar lives below the
      // stack but only renders when the terminal pane is on top — chat
      // doesn't need the modifier row.
      body: Column(
        children: [
          // Only show the term/chat toggle when chat is actually
          // available for this agent. For Gemini/Codex/OpenCode the
          // user just sees the terminal — no toggle to a panel that
          // can't render anything.
          if (_chatSupported)
            _ViewToggleBar(
              mode: _view,
              onChanged: (m) {
                if (m == _view) return;
                setState(() => _view = m);
                if (m == _ViewMode.chat) _ensureChatSubscribed();
              },
            ),
          Expanded(
            child: IndexedStack(
              index: _chatSupported && _view == _ViewMode.chat ? 1 : 0,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
                  child: TerminalView(
                    _terminal,
                    controller: _controller,
                    focusNode: _termFocus,
                    keyboardType: TextInputType.visiblePassword,
                    autofocus: false,
                    backgroundOpacity: 1,
                    padding: const EdgeInsets.all(6),
                    textStyle: const TerminalStyle(
                      fontFamily: 'JetBrainsMono',
                      fontFamilyFallback: ['Menlo', 'Courier New', 'monospace'],
                      fontSize: 12,
                    ),
                    theme: loopsyTerminalTheme,
                  ),
                ),
                ChatPanel(
                  log: _chatLog,
                  revision: _chatRevision,
                  agentName: _agentDisplayName(),
                  // Composer is enabled whenever the relay session is
                  // alive — NOT gated on chat capability, because the
                  // user's first message is what causes the agent to
                  // create its transcript file in the first place.
                  onSend: _session == null ? null : _sendChatPrompt,
                ),
              ],
            ),
          ),
          if (_view == _ViewMode.terminal)
            TerminalAccessoryBar(
              onBytes: _sendRawBytes,
              ctrlArmed: _ctrlArmed,
              altArmed: _altArmed,
              onToggleCtrl: () => setState(() {
                _ctrlArmed = !_ctrlArmed;
                if (_ctrlArmed) _altArmed = false;
              }),
              onToggleAlt: () => setState(() {
                _altArmed = !_altArmed;
                if (_altArmed) _ctrlArmed = false;
              }),
              onVoice: _voiceReady ? _openVoiceSheet : null,
            ),
        ],
      ),
    );
  }

  IconData _agentIcon() {
    switch (widget.agent) {
      case 'claude':
        return HugeIcons.strokeRoundedAiChat02;
      case 'gemini':
        return HugeIcons.strokeRoundedAiBrain02;
      case 'codex':
        return HugeIcons.strokeRoundedSourceCode;
      default:
        return HugeIcons.strokeRoundedCommandLine;
    }
  }

  /// Display name used in chat: turn-group headers ("Codex"), composer
  /// hint ("Message Codex…"), and loading dots ("Codex is working…").
  String _agentDisplayName() {
    switch (widget.agent) {
      case 'claude':
        return 'Claude';
      case 'gemini':
        return 'Gemini';
      case 'codex':
        return 'Codex';
      case 'opencode':
        return 'OpenCode';
      default:
        return widget.agent;
    }
  }
}

/// Full-width segmented strip pinned below the AppBar. Session-id moved
/// back to the AppBar actions next to the status pill so this bar can
/// span edge-to-edge — easier tap targets and matches the iOS pattern
/// of full-width segmented controls under the nav.
class _ViewToggleBar extends StatelessWidget {
  final _ViewMode mode;
  final ValueChanged<_ViewMode> onChanged;
  const _ViewToggleBar({required this.mode, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: LoopsyColors.surface,
        border: Border(bottom: BorderSide(color: LoopsyColors.border)),
      ),
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 8),
      child: Container(
        height: 32,
        decoration: BoxDecoration(
          color: LoopsyColors.surfaceAlt,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: LoopsyColors.border),
        ),
        padding: const EdgeInsets.all(2),
        child: Row(
          children: [
            Expanded(
              child: _SegmentButton(
                label: 'term',
                icon: HugeIcons.strokeRoundedCommandLine,
                selected: mode == _ViewMode.terminal,
                onTap: () => onChanged(_ViewMode.terminal),
              ),
            ),
            Expanded(
              child: _SegmentButton(
                label: 'chat',
                icon: HugeIcons.strokeRoundedAiChat02,
                selected: mode == _ViewMode.chat,
                onTap: () => onChanged(_ViewMode.chat),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SegmentButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;
  const _SegmentButton({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        decoration: BoxDecoration(
          color: selected ? LoopsyColors.accent : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        alignment: Alignment.center,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          mainAxisSize: MainAxisSize.min,
          children: [
            HugeIcon(
              icon: icon,
              color: selected ? LoopsyColors.bg : LoopsyColors.muted,
              size: 14,
            ),
            const SizedBox(width: 5),
            Text(
              label,
              style: TextStyle(
                color: selected ? LoopsyColors.bg : LoopsyColors.muted,
                fontSize: 12,
                fontWeight: FontWeight.w700,
                fontFamily: 'JetBrainsMono',
              ),
            ),
          ],
        ),
      ),
    );
  }
}
