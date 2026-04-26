import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

/// Loopsy design tokens. Keep in sync with the web client palette.
class LoopsyColors {
  static const bg = Color(0xFF0B0D10);
  static const surface = Color(0xFF14171C);
  static const surfaceAlt = Color(0xFF1D2128);
  static const border = Color(0xFF1F242B);
  static const accent = Color(0xFF7AA2F7);
  static const accentDark = Color(0xFF3954C4);
  static const good = Color(0xFF9ECE6A);
  static const warn = Color(0xFFE0AF68);
  static const bad = Color(0xFFF7768E);
  static const fg = Color(0xFFE7EAEE);
  static const muted = Color(0xFF6B7280);
}

ThemeData loopsyTheme() {
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: LoopsyColors.bg,
    colorScheme: const ColorScheme.dark(
      surface: LoopsyColors.surface,
      primary: LoopsyColors.accent,
      onPrimary: LoopsyColors.bg,
      secondary: LoopsyColors.accentDark,
      error: LoopsyColors.bad,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: LoopsyColors.surface,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: LoopsyColors.fg,
        fontSize: 17,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.2,
      ),
    ),
    iconTheme: const IconThemeData(color: LoopsyColors.fg, size: 22),
    cardTheme: CardThemeData(
      color: LoopsyColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: LoopsyColors.border),
      ),
    ),
    listTileTheme: const ListTileThemeData(iconColor: LoopsyColors.fg, textColor: LoopsyColors.fg),
    dividerTheme: const DividerThemeData(color: LoopsyColors.border, space: 1),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: LoopsyColors.accent,
        foregroundColor: LoopsyColors.bg,
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
      ),
    ),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      backgroundColor: LoopsyColors.accent,
      foregroundColor: LoopsyColors.bg,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: LoopsyColors.surfaceAlt,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide.none,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    ),
  );
}

/// Loopsy palette mapped to xterm's TerminalTheme. Colors are tuned to read
/// well on the dark surface and roughly match VS Code Dark+ for ANSI colors.
const TerminalTheme loopsyTerminalTheme = TerminalTheme(
  cursor: LoopsyColors.accent,
  selection: Color(0x507AA2F7),
  foreground: LoopsyColors.fg,
  background: LoopsyColors.bg,
  black: Color(0xFF1A1B26),
  red: Color(0xFFF7768E),
  green: Color(0xFF9ECE6A),
  yellow: Color(0xFFE0AF68),
  blue: Color(0xFF7AA2F7),
  magenta: Color(0xFFBB9AF7),
  cyan: Color(0xFF7DCFFF),
  white: Color(0xFFC0CAF5),
  brightBlack: Color(0xFF414868),
  brightRed: Color(0xFFFF7A93),
  brightGreen: Color(0xFFB9F27C),
  brightYellow: Color(0xFFFF9E64),
  brightBlue: Color(0xFF7DA6FF),
  brightMagenta: Color(0xFFBB9AF7),
  brightCyan: Color(0xFF0DB9D7),
  brightWhite: Color(0xFFD8E0F2),
  searchHitBackground: Color(0xFFFFFF2B),
  searchHitBackgroundCurrent: Color(0xFF31FF26),
  searchHitForeground: Color(0xFF000000),
);

