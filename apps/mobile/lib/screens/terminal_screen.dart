import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:xterm/xterm.dart';

import '../services/relay_client.dart';
import '../services/storage.dart';
import '../theme.dart';
import '../widgets/terminal_keyboard.dart';

class TerminalScreen extends StatefulWidget {
  final String sessionId;
  final String agent;
  final bool fresh;
  final bool auto;
  const TerminalScreen({
    super.key,
    required this.sessionId,
    required this.agent,
    required this.fresh,
    this.auto = false,
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

    _terminal.onOutput = (data) => _session?.sendStdin(utf8.encode(data));
    _terminal.onResize = (w, h, _, __) => _session?.resize(w, h);

    final session = RelaySession(
      pairing: pairing,
      sessionId: widget.sessionId,
      onPty: (bytes) => _terminal.write(utf8.decode(bytes, allowMalformed: true)),
      onControl: (msg) {
        if (msg['type'] == 'device-disconnected' && mounted) {
          setState(() { _status = 'device disconnected'; _statusError = true; });
        }
      },
      onClose: (code, _) {
        if (mounted) setState(() { _status = 'closed (${code ?? '?'})'; _statusError = code != 1000; });
      },
    );

    // Always send session-open: the daemon dedupes by sessionId — reuses an
    // existing PTY or spawns a fresh one if nothing exists for that id (e.g.,
    // after the daemon's idle timeout reaped the previous PTY).
    await session.open(
      agent: widget.agent,
      cols: _terminal.viewWidth,
      rows: _terminal.viewHeight,
      auto: widget.auto,
    );
    if (!mounted) return;
    setState(() {
      _session = session;
      _status = 'connected';
      _statusError = false;
    });

    // Lazy-init speech recognition; ignore errors silently — mic just becomes unavailable.
    _voiceReady = await _speech.initialize(onError: (_) {});
    if (mounted) setState(() {});
    // Bring keyboard up by default so users can type immediately.
    Future.delayed(const Duration(milliseconds: 200), () {
      if (mounted) _termFocus.requestFocus();
    });
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

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: LoopsyColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => StatefulBuilder(builder: (ctx, setSheet) {
        Future<void> startListening() async {
          userEdited = false;
          await _speech.listen(
            onResult: (res) {
              if (userEdited) return; // honor manual edits, stop overwriting
              setSheet(() {
                lastSpeech = res.recognizedWords;
                ctl.value = TextEditingValue(
                  text: lastSpeech,
                  selection: TextSelection.collapsed(offset: lastSpeech.length),
                );
              });
            },
            listenOptions: stt.SpeechListenOptions(partialResults: true),
          );
          setSheet(() => listening = true);
        }

        Future<void> stopListening() async {
          await _speech.stop();
          setSheet(() => listening = false);
        }

        // Auto-start listening when sheet opens.
        if (!listening && ctl.text.isEmpty) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (Navigator.of(ctx).canPop()) startListening();
          });
        }

        return Padding(
          padding: EdgeInsets.fromLTRB(20, 18, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  HugeIcon(
                    icon: listening ? HugeIcons.strokeRoundedMic01 : HugeIcons.strokeRoundedMicOff01,
                    color: listening ? LoopsyColors.bad : LoopsyColors.muted,
                    size: 22,
                  ),
                  const SizedBox(width: 10),
                  Text(
                    listening ? 'Listening… tap text to edit' : (userEdited ? 'Edited — review and send' : 'Tap mic to start'),
                    style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16),
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
                style: const TextStyle(color: LoopsyColors.muted, fontSize: 11),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  TextButton.icon(
                    onPressed: listening ? stopListening : startListening,
                    icon: HugeIcon(
                      icon: listening ? HugeIcons.strokeRoundedStopCircle : HugeIcons.strokeRoundedMic01,
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
                            _session?.sendStdin(utf8.encode('${ctl.text}\r'));
                            Navigator.pop(ctx);
                          },
                    icon: const HugeIcon(icon: HugeIcons.strokeRoundedSent, color: LoopsyColors.bg, size: 18),
                    label: const Text('Send'),
                  ),
                ],
              ),
            ],
          ),
        );
      }),
    );
    await _speech.stop();
    focus.dispose();
    ctl.dispose();
  }

  @override
  void dispose() {
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
          icon: const HugeIcon(icon: HugeIcons.strokeRoundedArrowLeft02, color: LoopsyColors.fg),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Row(
          children: [
            HugeIcon(
              icon: _agentIcon(),
              color: LoopsyColors.accent,
              size: 18,
            ),
            const SizedBox(width: 8),
            Text(widget.agent, style: const TextStyle(fontFamily: 'JetBrainsMono')),
            const SizedBox(width: 8),
            Container(width: 4, height: 4, decoration: const BoxDecoration(color: LoopsyColors.muted, shape: BoxShape.circle)),
            const SizedBox(width: 8),
            Text(
              widget.sessionId.substring(0, 6),
              style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 12, color: LoopsyColors.muted),
            ),
          ],
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Row(
              children: [
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
      body: Column(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: TerminalView(
                _terminal,
                controller: _controller,
                focusNode: _termFocus,
                // readOnly + hardwareKeyboardOnly: never engage the iOS soft
                // keyboard. Our custom TerminalKeyboard below sends raw bytes.
                readOnly: true,
                hardwareKeyboardOnly: true,
                autofocus: false,
                backgroundOpacity: 1,
                padding: const EdgeInsets.all(6),
                textStyle: const TerminalStyle(
                  fontFamily: 'JetBrainsMono',
                  fontFamilyFallback: ['Menlo', 'Courier New', 'monospace'],
                  fontSize: 13,
                ),
                theme: loopsyTerminalTheme,
              ),
            ),
          ),
          TerminalKeyboard(
            onBytes: (bytes) {
              _session?.sendStdin(bytes);
              _captureSummary(bytes);
            },
            onVoice: _voiceReady ? _openVoiceSheet : null,
          ),
        ],
      ),
    );
  }

  IconData _agentIcon() {
    switch (widget.agent) {
      case 'claude': return HugeIcons.strokeRoundedAiChat02;
      case 'gemini': return HugeIcons.strokeRoundedAiBrain02;
      case 'codex':  return HugeIcons.strokeRoundedSourceCode;
      default:       return HugeIcons.strokeRoundedCommandLine;
    }
  }
}

