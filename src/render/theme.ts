/**
 * Colour and material definitions for the 3D view.
 *
 * One palette drives the whole product: the viewport, the UI chrome and the
 * exported images. Materials are created once and shared — with a few thousand
 * instanced characters and several hundred furniture meshes on screen, every
 * duplicated material is a wasted draw call.
 */

import {
  Color,
  DoubleSide,
  MeshStandardMaterial,
  MeshBasicMaterial,
  LineBasicMaterial,
  type Material,
} from 'three'
import type { MaterialRole } from '../library/primitives'

export type ThemeName = 'light' | 'dark'

export interface Palette {
  background: string
  ground: string
  gridMinor: string
  gridMajor: string
  floor: string
  floorAlt: string
  wall: string
  wallTop: string
  wallGlass: string
  selection: string
  hover: string
  draft: string
  measure: string
  text: string
}

export const PALETTES: Record<ThemeName, Palette> = {
  light: {
    background: '#eef1f5',
    ground: '#e4e8ee',
    gridMinor: '#d3d9e2',
    gridMajor: '#b9c2cf',
    floor: '#f6f4f0',
    floorAlt: '#eceae5',
    wall: '#d9d5cd',
    wallTop: '#bdb8ae',
    wallGlass: '#a9c8d8',
    selection: '#2f7df6',
    hover: '#7fb0ff',
    draft: '#f08a3c',
    measure: '#8a5cf6',
    text: '#1d2430',
  },
  dark: {
    background: '#12161d',
    ground: '#1a1f28',
    gridMinor: '#262d38',
    gridMajor: '#39424f',
    floor: '#232833',
    floorAlt: '#1e232d',
    wall: '#39414f',
    wallTop: '#4a5464',
    wallGlass: '#3a5a6b',
    selection: '#59a0ff',
    hover: '#8cbcff',
    draft: '#ffa45c',
    measure: '#a888ff',
    text: '#e6ebf2',
  },
}

/** Base colours for furniture primitives, before any per-instance tint. */
const ROLE_COLORS: Record<MaterialRole, { color: string; roughness: number; metalness: number }> = {
  wood: { color: '#b08356', roughness: 0.7, metalness: 0 },
  woodDark: { color: '#6f4f34', roughness: 0.65, metalness: 0 },
  woodLight: { color: '#d9bb90', roughness: 0.72, metalness: 0 },
  metal: { color: '#9aa2ad', roughness: 0.45, metalness: 0.6 },
  metalDark: { color: '#4d545e', roughness: 0.5, metalness: 0.55 },
  chrome: { color: '#c9ced6', roughness: 0.2, metalness: 0.9 },
  fabric: { color: '#7d93b5', roughness: 0.92, metalness: 0 },
  fabricAlt: { color: '#9c7f9e', roughness: 0.92, metalness: 0 },
  leather: { color: '#8a5a44', roughness: 0.6, metalness: 0 },
  glass: { color: '#b7d6e6', roughness: 0.1, metalness: 0.1 },
  screen: { color: '#1f2733', roughness: 0.28, metalness: 0.2 },
  emissive: { color: '#ffe6a8', roughness: 0.9, metalness: 0 },
  plastic: { color: '#c2c7cd', roughness: 0.6, metalness: 0 },
  stone: { color: '#b6b2aa', roughness: 0.85, metalness: 0 },
  white: { color: '#f2f2f0', roughness: 0.75, metalness: 0 },
  dark: { color: '#33383f', roughness: 0.75, metalness: 0 },
  plant: { color: '#5c9a63', roughness: 0.9, metalness: 0 },
  plantDark: { color: '#3d6b45', roughness: 0.9, metalness: 0 },
  accent: { color: '#d97742', roughness: 0.75, metalness: 0 },
  paper: { color: '#efe9df', roughness: 0.9, metalness: 0 },
  carpet: { color: '#8a7f76', roughness: 0.98, metalness: 0 },
}

export const roleColor = (role: MaterialRole): string => ROLE_COLORS[role].color

/** Ordered list of roles; the index becomes a vertex attribute on merged geometry. */
export const MATERIAL_ROLES = Object.keys(ROLE_COLORS) as MaterialRole[]

export const ROLE_INDEX: Record<MaterialRole, number> = MATERIAL_ROLES.reduce(
  (acc, role, index) => {
    acc[role] = index
    return acc
  },
  {} as Record<MaterialRole, number>,
)

/** Colours of the states a simulated person can be in. */
export const AGENT_STATE_COLORS = {
  walking: '#4c7dd4',
  queuing: '#e0a23f',
  waiting: '#e0a23f',
  served: '#8a5cf6',
  seated: '#5f8a9c',
  dwelling: '#3fb27f',
  blocked: '#e0603f',
  done: '#8b95a3',
} as const

export type AgentStateName = keyof typeof AGENT_STATE_COLORS

/** Re-exported so the renderer and the UI classify density the same way. */
export {
  LOS_TABLES,
  losFor,
  losIndex,
  LOS_COLORS,
  CROWD_SAFETY,
  crowdSafetyLevel,
} from '../sim/metrics/los'
export type { FacilityType, LosBand } from '../sim/metrics/los'

/** Shared material cache, rebuilt when the theme changes. */
export class MaterialLibrary {
  private cache = new Map<string, Material>()
  palette: Palette

  constructor(public theme: ThemeName = 'light') {
    this.palette = PALETTES[theme]
  }

  setTheme(theme: ThemeName): void {
    if (theme === this.theme) return
    this.theme = theme
    this.palette = PALETTES[theme]
    this.dispose()
  }

  private remember<T extends Material>(key: string, create: () => T): T {
    const existing = this.cache.get(key)
    if (existing) return existing as T
    const created = create()
    this.cache.set(key, created)
    return created
  }

  /** Vertex-coloured material used by all merged furniture geometry. */
  furniture(): MeshStandardMaterial {
    return this.remember(
      'furniture',
      () =>
        new MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.72,
          metalness: 0.06,
        }),
    )
  }

  wall(): MeshStandardMaterial {
    return this.remember(
      `wall:${this.theme}`,
      () =>
        new MeshStandardMaterial({
          color: new Color(this.palette.wall),
          roughness: 0.92,
          metalness: 0,
        }),
    )
  }

  glass(): MeshStandardMaterial {
    return this.remember(
      `glass:${this.theme}`,
      () =>
        new MeshStandardMaterial({
          color: new Color(this.palette.wallGlass),
          roughness: 0.15,
          metalness: 0.1,
          transparent: true,
          opacity: 0.32,
          side: DoubleSide,
        }),
    )
  }

  floor(): MeshStandardMaterial {
    return this.remember(
      `floor:${this.theme}`,
      () =>
        new MeshStandardMaterial({
          color: new Color(this.palette.floor),
          roughness: 0.96,
          metalness: 0,
        }),
    )
  }

  ground(): MeshStandardMaterial {
    return this.remember(
      `ground:${this.theme}`,
      () =>
        new MeshStandardMaterial({
          color: new Color(this.palette.ground),
          roughness: 1,
          metalness: 0,
        }),
    )
  }

  /** Flat translucent fill used for zones and highlights. */
  overlay(color: string, opacity: number): MeshBasicMaterial {
    return this.remember(
      `overlay:${color}:${opacity}`,
      () =>
        new MeshBasicMaterial({
          color: new Color(color),
          transparent: true,
          opacity,
          depthWrite: false,
          side: DoubleSide,
        }),
    )
  }

  line(color: string, opacity = 1): LineBasicMaterial {
    return this.remember(
      `line:${color}:${opacity}`,
      () =>
        new LineBasicMaterial({
          color: new Color(color),
          transparent: opacity < 1,
          opacity,
          depthTest: true,
        }),
    )
  }

  agents(): MeshStandardMaterial {
    return this.remember(
      'agents',
      () => new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.02 }),
    )
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose()
    this.cache.clear()
  }
}
