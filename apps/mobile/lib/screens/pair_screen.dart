import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';

import '../services/pair_url.dart';
import '../services/relay_client.dart';
import '../services/storage.dart';

class PairScreen extends StatefulWidget {
  const PairScreen({super.key});

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _scanController = MobileScannerController(detectionSpeed: DetectionSpeed.noDuplicates);
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _ensurePermission();
  }

  Future<void> _ensurePermission() async {
    final st = await Permission.camera.request();
    if (!st.isGranted && mounted) {
      setState(() => _error = 'Camera permission denied. Enter pair URL manually.');
    }
  }

  @override
  void dispose() {
    _scanController.dispose();
    super.dispose();
  }

  Future<void> _consume(String text) async {
    if (_busy) return;
    final parsed = parsePairUrl(text);
    if (parsed == null) {
      setState(() => _error = 'That doesn\'t look like a Loopsy pair URL.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final pairing = await redeemPairToken(parsed, label: 'mobile-app');
      await Storage.writePairing(pairing);
      if (mounted) context.go('/');
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _enterManually() async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Enter pair URL'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(hintText: 'loopsy://pair?u=...&t=...'),
          autofocus: true,
          autocorrect: false,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Pair'),
          ),
        ],
      ),
    );
    if (result != null && result.isNotEmpty) await _consume(result);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair your phone')),
      body: Stack(
        children: [
          MobileScanner(
            controller: _scanController,
            onDetect: (capture) {
              for (final code in capture.barcodes) {
                final raw = code.rawValue;
                if (raw != null && raw.isNotEmpty) {
                  _scanController.stop();
                  _consume(raw);
                  break;
                }
              }
            },
          ),
          // Bottom panel
          Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: Colors.black.withOpacity(0.7),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Column(
                        children: [
                          const Text(
                            'On your laptop run:\n  loopsy mobile pair',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: Colors.white),
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            'Then point your camera at the QR.',
                            style: TextStyle(color: Colors.white70, fontSize: 12),
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 12),
                            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextButton(
                      onPressed: _enterManually,
                      child: const Text('Enter URL manually'),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (_busy)
            const ColoredBox(
              color: Color(0xAA000000),
              child: Center(child: CircularProgressIndicator()),
            ),
        ],
      ),
    );
  }
}
