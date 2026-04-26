import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'screens/home_screen.dart';
import 'screens/pair_screen.dart';
import 'screens/terminal_screen.dart';
import 'services/storage.dart';
import 'theme.dart';

void main() {
  runApp(const LoopsyApp());
}

class LoopsyApp extends StatelessWidget {
  const LoopsyApp({super.key});

  @override
  Widget build(BuildContext context) {
    final router = GoRouter(
      initialLocation: '/',
      redirect: (ctx, state) async {
        if (state.matchedLocation == '/pair') return null;
        final p = await Storage.readPairing();
        if (p == null) return '/pair';
        return null;
      },
      routes: [
        GoRoute(path: '/', builder: (ctx, st) => const HomeScreen()),
        GoRoute(path: '/pair', builder: (ctx, st) => const PairScreen()),
        GoRoute(
          path: '/terminal/:id',
          builder: (ctx, st) {
            final id = st.pathParameters['id']!;
            final agent = st.uri.queryParameters['agent'] ?? 'shell';
            final fresh = (st.uri.queryParameters['fresh'] ?? '0') == '1';
            final auto = (st.uri.queryParameters['auto'] ?? '0') == '1';
            return TerminalScreen(sessionId: id, agent: agent, fresh: fresh, auto: auto);
          },
        ),
      ],
    );

    return MaterialApp.router(
      title: 'Loopsy',
      theme: loopsyTheme(),
      themeMode: ThemeMode.dark,
      routerConfig: router,
    );
  }
}
