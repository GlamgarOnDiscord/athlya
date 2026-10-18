import nativewindPreset from 'nativewind/preset';
import type { Config } from 'tailwindcss';

import { buildMobileTheme } from './theme/preset';

const config: Config = {
  content: { relative: true, files: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'] },
  presets: [nativewindPreset],
  darkMode: 'media',
  theme: { extend: buildMobileTheme() },
};

export default config;
