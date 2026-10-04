/**
 * Edit presets.
 *
 * A preset is a *reviewed* edit shape: a house pattern for a common deliverable that has already
 * been certified once. The point is not to save typing — it is that a preset is a claim somebody
 * checked, so using one is safer than inventing the same cut from scratch.
 *
 * Every preset is a pure data literal. Nothing here computes anything: presets declare frame
 * arithmetic, and the Python engine proves it. A preset that does not certify is a bug in the
 * preset, not a reason to trust it.
 */

export const manifest = {
  name: 'presets',
  version: '0.1.0',
}

const RATE_25 = { num: 25, den: 1 }
const RATE_2997 = { num: 30000, den: 1001 }

/**
 * @typedef {object} Preset
 * @property {string} name            kebab-case identifier
 * @property {string} title           human label
 * @property {string} summary         one line on when to reach for it
 * @property {string} expects         the source programs the preset draws from
 * @property {{num: number, den: number}} frameRate
 * @property {Array<object>} program
 * @property {Array<object>} edl
 */

/** @type {readonly Preset[]} */
export const presets = [
  {
    name: 'bumper-6s',
    title: 'Six-second bumper',
    summary: 'Cold open, two punchy B-roll cuts, dip to black. The default ad bumper shape.',
    expects: 'Two or more sources of at least 150 frames at 25fps.',
    frameRate: RATE_25,
    program: {
      frame_rate: RATE_25,
      sources: [
        { id: 'hero', duration_frames: 2500 },
        { id: 'broll', duration_frames: 2500 },
      ],
    },
    edl: [
      { source_id: 'hero', src_start_frame: 0, frame_count: 50, token_id: 'cold-open' },
      { source_id: 'broll', src_start_frame: 0, frame_count: 50, token_id: 'punch-1' },
      { source_id: 'broll', src_start_frame: 50, frame_count: 50, token_id: 'punch-2' },
    ],
  },
  {
    name: 'podcast-opener',
    title: 'Podcast opener',
    summary: 'Host cold open into a title card dissolve. Two sources, one transition.',
    expects: 'A host camera and a title-card source at 29.97fps.',
    frameRate: RATE_2997,
    program: {
      frame_rate: RATE_2997,
      sources: [
        { id: 'host', duration_frames: 45000 },
        { id: 'title', duration_frames: 900 },
      ],
    },
    edl: [
      { source_id: 'host', src_start_frame: 1500, frame_count: 900, token_id: 'host-open' },
      { source_id: 'title', src_start_frame: 0, frame_count: 150, transition: 'dissolve' },
    ],
  },
  {
    name: 'flashback',
    title: 'Flashback sandwich',
    summary: 'Deliberately reuses one source range. Exists to show that overlap is reported, not forbidden.',
    expects: 'A single source of at least 200 frames at 25fps.',
    frameRate: RATE_25,
    program: {
      frame_rate: RATE_25,
      sources: [{ id: 'archive', duration_frames: 1000 }],
    },
    edl: [
      { source_id: 'archive', src_start_frame: 0, frame_count: 100, token_id: 'present' },
      { source_id: 'archive', src_start_frame: 0, frame_count: 50, token_id: 'flashback' },
      { source_id: 'archive', src_start_frame: 150, frame_count: 100, token_id: 'present-again' },
    ],
  },
]

/** @returns {Preset | undefined} */
export function getPreset(name) {
  return presets.find((preset) => preset.name === name)
}

export function describe() {
  return { plugin: manifest.name, capabilities: ['edl.presets', 'edl.presets.list'] }
}
