/**
 * `bdg cloak human-config` — static reference for the CloakBrowser SDK's
 * `HumanConfigOverrides` (human/config.py:23-64).
 *
 * `--human-config` accepts a JSON object overriding individual humanization
 * parameters on top of the chosen `--human-preset`. The SDK's `merge_config`
 * **silently ignores unknown keys**, so a typo'd key does nothing — this
 * command lists the real keys so they're discoverable, and `bodyFromOptions`
 * warns when a key isn't in this set.
 *
 * No API call is made — this is a static, agent-friendly self-reference
 * (mirrors `bdg cloak create --list-fields`).
 */

import type { Command } from 'commander';

import { jsonOption } from '@/commands/shared/commonOptions.js';
import { buildSuccessResponse } from '@/ui/OutputBuilder.js';
import { joinLines } from '@/ui/formatting.js';
import { EXIT_CODES } from '@/utils/exitCodes.js';

/** One overridable humanization parameter. */
export interface HumanConfigField {
  /** SDK `HumanConfigOverrides` key (snake_case). */
  key: string;
  /** Logical group, for the rendered table. */
  category: 'Keyboard' | 'Mistype' | 'Mouse motion' | 'Mouse clicks' | 'Idle' | 'Scroll' | 'Cursor';
  /** Display type (e.g. "ms", "float 0–1", "[min,max]", "bool", "px"). */
  type: string;
  /** Default from the `default` preset, or "preset" when preset-derived. */
  default: string;
  /** Short description. */
  description: string;
}

/**
 * The full set of overridable keys, mirroring cloakbrowser `human/config.py`.
 * Defaults shown only where the SDK's `HumanConfig` dataclass pins them; the
 * rest are preset-derived ("preset").
 */
export const HUMAN_CONFIG_FIELDS: HumanConfigField[] = [
  // ── Keyboard / typing cadence ──
  {
    key: 'typing_delay',
    category: 'Keyboard',
    type: 'ms',
    default: '70',
    description: 'Base per-keystroke delay.',
  },
  {
    key: 'typing_delay_spread',
    category: 'Keyboard',
    type: 'ms',
    default: 'preset',
    description: 'Random spread added to typing_delay.',
  },
  {
    key: 'typing_pause_chance',
    category: 'Keyboard',
    type: 'float 0–1',
    default: 'preset',
    description: 'Chance of a longer thinking pause between keystrokes.',
  },
  {
    key: 'typing_pause_range',
    category: 'Keyboard',
    type: '[min,max] ms',
    default: 'preset',
    description: 'Range of the thinking pause.',
  },
  {
    key: 'shift_down_delay',
    category: 'Keyboard',
    type: 'ms',
    default: 'preset',
    description: 'Delay before pressing Shift.',
  },
  {
    key: 'shift_up_delay',
    category: 'Keyboard',
    type: 'ms',
    default: 'preset',
    description: 'Delay before releasing Shift.',
  },
  {
    key: 'key_hold',
    category: 'Keyboard',
    type: 'ms',
    default: 'preset',
    description: 'How long a key is held down.',
  },
  {
    key: 'field_switch_delay',
    category: 'Keyboard',
    type: 'ms',
    default: 'preset',
    description: 'Delay when moving between input fields.',
  },

  // ── Mistype / typo simulation ──
  {
    key: 'mistype_chance',
    category: 'Mistype',
    type: 'float 0–1',
    default: 'preset',
    description: 'Chance of simulating a typo per keystroke.',
  },
  {
    key: 'mistype_delay_notice',
    category: 'Mistype',
    type: 'ms',
    default: 'preset',
    description: 'Delay before noticing the typo.',
  },
  {
    key: 'mistype_delay_correct',
    category: 'Mistype',
    type: 'ms',
    default: 'preset',
    description: 'Delay before correcting the typo.',
  },

  // ── Mouse motion (Bézier curves) ──
  {
    key: 'mouse_steps_divisor',
    category: 'Mouse motion',
    type: 'float',
    default: 'preset',
    description: 'Divisor for the number of curve steps.',
  },
  {
    key: 'mouse_min_steps',
    category: 'Mouse motion',
    type: 'int',
    default: 'preset',
    description: 'Minimum mouse-path steps.',
  },
  {
    key: 'mouse_max_steps',
    category: 'Mouse motion',
    type: 'int',
    default: 'preset',
    description: 'Maximum mouse-path steps.',
  },
  {
    key: 'mouse_wobble_max',
    category: 'Mouse motion',
    type: 'px',
    default: '1.5',
    description: 'Maximum perpendicular wobble of the path.',
  },
  {
    key: 'mouse_overshoot_chance',
    category: 'Mouse motion',
    type: 'float 0–1',
    default: '0.15',
    description: 'Chance of overshooting the target.',
  },
  {
    key: 'mouse_overshoot_px',
    category: 'Mouse motion',
    type: 'px',
    default: 'preset',
    description: 'How far past the target to overshoot.',
  },
  {
    key: 'mouse_burst_size',
    category: 'Mouse motion',
    type: 'int',
    default: 'preset',
    description: 'Number of steps in a fast burst.',
  },
  {
    key: 'mouse_burst_pause',
    category: 'Mouse motion',
    type: 'ms',
    default: 'preset',
    description: 'Pause between bursts.',
  },

  // ── Mouse clicks (aim / hold / jitter) ──
  {
    key: 'click_aim_delay_input',
    category: 'Mouse clicks',
    type: 'ms',
    default: 'preset',
    description: 'Aim delay before clicking an input.',
  },
  {
    key: 'click_aim_delay_button',
    category: 'Mouse clicks',
    type: 'ms',
    default: 'preset',
    description: 'Aim delay before clicking a button.',
  },
  {
    key: 'click_hold_input',
    category: 'Mouse clicks',
    type: 'ms',
    default: 'preset',
    description: 'How long an input click is held.',
  },
  {
    key: 'click_hold_button',
    category: 'Mouse clicks',
    type: 'ms',
    default: 'preset',
    description: 'How long a button click is held.',
  },
  {
    key: 'click_input_x_range',
    category: 'Mouse clicks',
    type: 'px',
    default: 'preset',
    description: 'Horizontal jitter for input clicks.',
  },

  // ── Idle behaviour ──
  {
    key: 'idle_drift_px',
    category: 'Idle',
    type: 'px',
    default: 'preset',
    description: 'How far the cursor drifts while idle.',
  },
  {
    key: 'idle_pause_range',
    category: 'Idle',
    type: '[min,max] ms',
    default: 'preset',
    description: 'Range of idle pauses.',
  },
  {
    key: 'idle_between_actions',
    category: 'Idle',
    type: 'bool',
    default: 'false',
    description: 'Insert idle pauses between actions.',
  },
  {
    key: 'idle_between_duration',
    category: 'Idle',
    type: '[min,max] ms',
    default: 'preset',
    description: 'Range of the between-actions idle.',
  },

  // ── Scroll behaviour ──
  {
    key: 'scroll_delta_base',
    category: 'Scroll',
    type: '[min,max] px',
    default: '(80,130)',
    description: 'Base scroll delta per wheel tick.',
  },
  {
    key: 'scroll_delta_variance',
    category: 'Scroll',
    type: 'px',
    default: 'preset',
    description: 'Random variance on the scroll delta.',
  },
  {
    key: 'scroll_pause_fast',
    category: 'Scroll',
    type: 'ms',
    default: 'preset',
    description: 'Pause between fast scroll ticks.',
  },
  {
    key: 'scroll_pause_slow',
    category: 'Scroll',
    type: 'ms',
    default: 'preset',
    description: 'Pause between slow scroll ticks.',
  },
  {
    key: 'scroll_accel_steps',
    category: 'Scroll',
    type: 'int',
    default: 'preset',
    description: 'Steps to accelerate at scroll start.',
  },
  {
    key: 'scroll_decel_steps',
    category: 'Scroll',
    type: 'int',
    default: 'preset',
    description: 'Steps to decelerate at scroll end.',
  },
  {
    key: 'scroll_overshoot_chance',
    category: 'Scroll',
    type: 'float 0–1',
    default: 'preset',
    description: 'Chance of scrolling past the target then back.',
  },
  {
    key: 'scroll_overshoot_px',
    category: 'Scroll',
    type: 'px',
    default: 'preset',
    description: 'How far past to overshoot when scrolling.',
  },
  {
    key: 'scroll_settle_delay',
    category: 'Scroll',
    type: 'ms',
    default: 'preset',
    description: 'Delay after scroll settles.',
  },
  {
    key: 'scroll_target_zone',
    category: 'Scroll',
    type: 'px',
    default: 'preset',
    description: 'Target zone radius for scroll-to-element.',
  },
  {
    key: 'scroll_pre_move_delay',
    category: 'Scroll',
    type: 'ms',
    default: 'preset',
    description: 'Delay before starting to scroll.',
  },

  // ── Initial cursor position ──
  {
    key: 'initial_cursor_x',
    category: 'Cursor',
    type: '[min,max] px',
    default: '(400,700)',
    description: 'Initial cursor X range.',
  },
  {
    key: 'initial_cursor_y',
    category: 'Cursor',
    type: '[min,max] px',
    default: 'preset',
    description: 'Initial cursor Y range.',
  },
];

/** The set of valid `--human-config` keys (for `bodyFromOptions` validation). */
export const HUMAN_CONFIG_KEYS: ReadonlySet<string> = new Set(
  HUMAN_CONFIG_FIELDS.map((f) => f.key)
);

/** Render the human-config reference as a grouped table (no API call). */
export function humanConfigTable(): string {
  const head = `${'key'.padEnd(26)} ${'type'.padEnd(14)} ${'default'.padEnd(12)} description`;
  const rows = HUMAN_CONFIG_FIELDS.map(
    (f) => `${f.key.padEnd(26)} ${f.type.padEnd(14)} ${f.default.padEnd(12)} ${f.description}`
  );
  return [head, ...rows].join('\n');
}

/**
 * Register `bdg cloak human-config` — a static, no-API-call reference listing
 * the SDK's overridable humanization parameters.
 */
export function registerCloakHumanConfigCommand(program: Command): void {
  program
    .command('human-config')
    .description('List overridable --human-config keys (SDK HumanConfigOverrides)')
    .addOption(jsonOption())
    .action((options: { json?: boolean }) => {
      if (options.json) {
        console.log(JSON.stringify(buildSuccessResponse(HUMAN_CONFIG_FIELDS), null, 2));
      } else {
        console.log(
          joinLines(
            'Humanization overrides (cloakbrowser HumanConfigOverrides)',
            'Used with --humanize and --human-preset; pass as JSON to --human-config.',
            'Unknown keys are silently ignored by the SDK — validate with this list.',
            '',
            humanConfigTable()
          )
        );
      }
      process.exit(EXIT_CODES.SUCCESS);
    });
}
