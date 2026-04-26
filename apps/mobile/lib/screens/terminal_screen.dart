import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:xterm/xterm.dart';

import '../services/relay_client.dart';
import '../services/storage.dart';

class TerminalScreen extends StatefulWidget {
  final String sessionId;
  final String agent;
  final bool fresh;
  const TerminalScreen({
    super.key,
    required this.sessionId,
    required this.agent,
    required this.fresh,
  });

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late final Terminal _terminal = Terminal(maxLines: 10000);
  late final TerminalController _controller = TerminalController();
  RelaySession? _session;
  String _status = 'connecting…';
  bool _statusError = false;

  // Voice
  final stt.SpeechToText _speech = stt.SpeechToText();
  bool _voiceReady = false;
  bool _listening = false;
  final TextEditingController _composeCtl = TextEditingController();

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

    if (widget.fresh) {
      await session.open(agent: widget.agent, cols: _terminal.viewWidth, rows: _terminal.viewHeight);
    } else {
      await session.reattach(cols: _terminal.viewWidth, rows: _terminal.viewHeight);
    }
    if (!mounted) return;
    setState(() { _session = session; _status = 'connected'; _statusError = false; });

    // Init speech recognition lazily.
    _voiceReady = await _speech.initialize(onError: (_) {});
    if (mounted) setState(() {});
  }

  void _toggleVoice() async {
    if (!_voiceReady) return;
    if (_listening) {
      await _speech.stop();
      setState(() => _listening = false);
      return;
    }
    setState(() => _listening = true);
    await _speech.listen(
      onResult: (res) {
        _composeCtl.text = res.recognizedWords;
        _composeCtl.selection = TextSelection.fromPosition(TextPosition(offset: _composeCtl.text.length));
      },
      listenOptions: stt.SpeechListenOptions(partialResults: true),
    );
  }

  void _sendCompose() {
    final t = _composeCtl.text;
    if (t.isEmpty || _session == null) return;
    _session!.sendStdin(utf8.encode('$t\r'));
    _composeCtl.clear();
  }

  @override
  void dispose() {
    _session?.close();
    _composeCtl.dispose();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: const Color(0xFF14171c),
        title: Text(
          '${widget.agent} · ${widget.sessionId.substring(0, 8)}',
          style: const TextStyle(fontFamily: 'monospace'),
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: Text(
                _status,
                style: TextStyle(
                  color: _statusError ? Colors.redAccent : Colors.greenAccent,
                  fontSize: 12,
                ),
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: TerminalView(
              _terminal,
              controller: _controller,
              autofocus: true,
              backgroundOpacity: 1,
              keyboardType: TextInputType.text,
              hardwareKeyboardOnly: false,
            ),
          ),
          _ComposeBar(
            controller: _composeCtl,
            onSend: _sendCompose,
            onVoice: _voiceReady ? _toggleVoice : null,
            listening: _listening,
          ),
        ],
      ),
    );
  }
}

class _ComposeBar extends StatelessWidget {
  final TextEditingController controller;
  final VoidCallback onSend;
  final VoidCallback? onVoice;
  final bool listening;

  const _ComposeBar({
    required this.controller,
    required this.onSend,
    required this.onVoice,
    required this.listening,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFF14171c),
      padding: EdgeInsets.fromLTRB(8, 6, 8, 6 + MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            IconButton(
              icon: Icon(listening ? Icons.stop_circle : Icons.mic),
              color: listening ? Colors.redAccent : Colors.white70,
              onPressed: onVoice,
              tooltip: onVoice == null ? 'Speech recognition unavailable' : 'Voice',
            ),
            Expanded(
              child: TextField(
                controller: controller,
                style: const TextStyle(color: Colors.white, fontFamily: 'monospace', fontSize: 14),
                decoration: const InputDecoration(
                  filled: true,
                  fillColor: Color(0xFF1d2128),
                  hintText: 'Type or dictate, send to PTY…',
                  hintStyle: TextStyle(color: Colors.white38),
                  border: OutlineInputBorder(borderSide: BorderSide.none, borderRadius: BorderRadius.all(Radius.circular(8))),
                  contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
              ),
            ),
            const SizedBox(width: 6),
            IconButton(
              icon: const Icon(Icons.send, color: Color(0xFF7aa2f7)),
              onPressed: onSend,
              tooltip: 'Send',
            ),
          ],
        ),
      ),
    );
  }
}
