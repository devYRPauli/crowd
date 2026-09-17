import { describe, expect, it, vi } from 'vitest'
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  ShaderLib,
  Vector3,
  type MeshStandardMaterial,
} from 'three'
import { CrowdRenderer, STATE_COLORS, type CrowdFrameInput } from './CrowdRenderer'
import { PIVOTS, SKIN_TONES } from './character'
import { AGENT_FIELD, AGENT_STATE_ORDER, AGENT_STRIDE } from '../../sim/types'
import { AGENT_PROFILES, POPULATION_COLORS } from '../../core/model/defaults'
import { AGENT_STATE_COLORS } from '../theme'

interface Person {
  x: number
  y: number
  heading: number
  speed: number
  state: number
  profile: number
  population: number
  waited: number
  radius: number
  id: number
}

const crowd = (people: Array<Partial<Person>>): Float32Array => {
  const out = new Float32Array(people.length * AGENT_STRIDE)
  people.forEach((person, index) => {
    const base = index * AGENT_STRIDE
    out[base + AGENT_FIELD.x] = person.x ?? 0
    out[base + AGENT_FIELD.y] = person.y ?? 0
    out[base + AGENT_FIELD.heading] = person.heading ?? 0
    out[base + AGENT_FIELD.speed] = person.speed ?? 1.2
    out[base + AGENT_FIELD.state] = person.state ?? 0
    out[base + AGENT_FIELD.profile] = person.profile ?? 0
    out[base + AGENT_FIELD.population] = person.population ?? 0
    out[base + AGENT_FIELD.waited] = person.waited ?? 0
    out[base + AGENT_FIELD.radius] = person.radius ?? 0.23
    out[base + AGENT_FIELD.id] = person.id ?? index + 1
  })
  return out
}

const frame = (
  people: Array<Partial<Person>>,
  extra: Partial<CrowdFrameInput> = {},
): CrowdFrameInput => {
  const agents = crowd(people)
  return {
    agents,
    count: people.length,
    profiles: AGENT_PROFILES,
    populationColors: POPULATION_COLORS,
    colorMode: 'state',
    time: 0,
    ...extra,
  }
}

const meshOf = (renderer: CrowdRenderer): InstancedMesh =>
  renderer.group.children[0] as InstancedMesh

const attribute = (renderer: CrowdRenderer, name: string, index: number): number =>
  meshOf(renderer).geometry.getAttribute(name).getX(index)

const tintOf = (renderer: CrowdRenderer, index: number): Color => {
  const tint = meshOf(renderer).geometry.getAttribute('aTint')
  return new Color(tint.getX(index), tint.getY(index), tint.getZ(index))
}

/**
 * The tint the renderer writes for a given palette hex. Three decodes the hex
 * into the working space the instanced buffer holds and `getHexString` encodes
 * it back, so the round trip is the token itself; the tests below are about
 * which token gets picked, not about the spaces it passes through.
 */
const asWritten = (hex: string): string => new Color(hex).getHexString()

const transformOf = (renderer: CrowdRenderer, index: number) => {
  const matrix = new Matrix4()
  meshOf(renderer).getMatrixAt(index, matrix)
  const position = new Vector3()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  matrix.decompose(position, quaternion, scale)
  return { position, quaternion, scale }
}

describe('drawing the crowd', () => {
  it('holds the whole crowd in one instanced mesh', () => {
    const renderer = new CrowdRenderer()
    const mesh = meshOf(renderer)
    expect(renderer.group.children).toHaveLength(1)
    expect(mesh).toBeInstanceOf(InstancedMesh)
    // Nothing is drawn until a frame arrives, and the buffers are rewritten
    // every frame, so the driver is told not to hold on to them.
    expect(mesh.count).toBe(0)
    expect(mesh.instanceMatrix.usage).toBe(DynamicDrawUsage)
    // The bounding sphere covers one person at the origin; a crowd spreads out
    // across the venue, so culling on it would empty the floor.
    expect(mesh.frustumCulled).toBe(false)
  })

  it('draws exactly as many people as the simulation reports', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{}, {}, {}]))
    expect(meshOf(renderer).count).toBe(3)

    renderer.update(frame([{}]))
    expect(meshOf(renderer).count).toBe(1)

    renderer.clear()
    expect(meshOf(renderer).count).toBe(0)
  })

  it('stops at the instance buffer rather than writing past it', () => {
    // The buffer holds 6000. A bigger crowd has to draw short, not corrupt
    // memory or throw in the middle of a run.
    const renderer = new CrowdRenderer()
    renderer.update(frame(Array.from({ length: 7000 }, (_, i) => ({ id: i }))))
    expect(meshOf(renderer).count).toBe(6000)
  })

  it('costs one matrix write per person and nothing else per frame', () => {
    // The invariant the crowd design rests on: no skeleton update, no object
    // per person, one compose and one write, in slot order so the instanced
    // buffer stays contiguous.
    const renderer = new CrowdRenderer()
    const write = vi.spyOn(meshOf(renderer), 'setMatrixAt')
    const version = meshOf(renderer).instanceMatrix.version
    renderer.update(frame([{}, {}, {}, {}]))

    expect(write).toHaveBeenCalledTimes(4)
    expect(write.mock.calls.map((call) => call[0])).toEqual([0, 1, 2, 3])
    // And the whole buffer is handed to the driver once for the frame, not
    // once per person.
    expect(meshOf(renderer).instanceMatrix.version).toBe(version + 1)
    write.mockRestore()
  })

  it('places a person by writing one matrix, feet on the floor', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ x: 3, y: 4, heading: 0, profile: 3 }]))

    const { position, quaternion, scale } = transformOf(renderer, 0)
    // Plan y is world z, and people stand on the ground rather than in it.
    expect(position.toArray()).toEqual([3, 0, 4])
    // A child is drawn at the profile's height, uniformly.
    expect(scale.x).toBeCloseTo(AGENT_PROFILES[3].heightScale, 6)
    expect(scale.y).toBeCloseTo(scale.x, 9)
    expect(scale.z).toBeCloseTo(scale.x, 9)

    // The character is modelled facing +z, and a heading of 0 faces +x.
    const facing = new Vector3(0, 0, 1).applyQuaternion(quaternion)
    expect(facing.x).toBeCloseTo(1, 6)
    expect(facing.z).toBeCloseTo(0, 6)
  })

  it('turns a person to the heading the simulation gave them', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ heading: Math.PI / 2 }, { heading: Math.PI }]))

    const north = new Vector3(0, 0, 1).applyQuaternion(transformOf(renderer, 0).quaternion)
    expect(north.z).toBeCloseTo(1, 6)
    const west = new Vector3(0, 0, 1).applyQuaternion(transformOf(renderer, 1).quaternion)
    expect(west.x).toBeCloseTo(-1, 6)
  })

  it('advances the gait by the distance walked, not by the frame', () => {
    const renderer = new CrowdRenderer()
    // The phase is seeded off the id so a crowd does not march in step.
    renderer.update(frame([{ id: 5, speed: 1.2 }]))
    expect(attribute(renderer, 'aPhase', 0)).toBeCloseTo((5 % 17) * 0.37, 5)

    renderer.update(frame([{ id: 5, speed: 1.2 }], { time: 0.5 }))
    // Step frequency rises with speed, as it does in real walking.
    expect(attribute(renderer, 'aPhase', 0)).toBeCloseTo(
      (5 % 17) * 0.37 + 0.5 * (1.9 + 1.2 * 1.15),
      4,
    )
    // Full stride at walking pace, none at all when stopped.
    expect(attribute(renderer, 'aGait', 0)).toBeCloseTo(Math.min(1, 1.2 / 1.1), 6)
  })

  it('leaves a standing person shifting their weight, not walking on the spot', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ id: 5, speed: 0 }]))
    renderer.update(frame([{ id: 5, speed: 0 }], { time: 0.5 }))
    expect(attribute(renderer, 'aGait', 0)).toBe(0)
    // The phase still creeps, so a queue is not a row of statues.
    expect(attribute(renderer, 'aPhase', 0)).toBeCloseTo((5 % 17) * 0.37 + 0.5 * 1.9 * 0.35, 4)
  })

  it('keeps a person walking when the crowd array is reordered under them', () => {
    // People are compacted out of the array as they leave, so a person's slot
    // changes; keying the gait on the slot makes everyone stutter.
    const renderer = new CrowdRenderer()
    renderer.update(
      frame([
        { id: 1, speed: 1 },
        { id: 2, speed: 1 },
      ]),
    )
    const first = attribute(renderer, 'aPhase', 0)
    const second = attribute(renderer, 'aPhase', 1)
    expect(first).not.toBeCloseTo(second, 3)

    renderer.update(
      frame(
        [
          { id: 2, speed: 1 },
          { id: 1, speed: 1 },
        ],
        { time: 0.25 },
      ),
    )
    const advance = 0.25 * (1.9 + 1.15)
    expect(attribute(renderer, 'aPhase', 0)).toBeCloseTo(second + advance, 4)
    expect(attribute(renderer, 'aPhase', 1)).toBeCloseTo(first + advance, 4)
  })

  it('does not spin the legs when a frame arrives late or out of order', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ id: 5, speed: 1 }]))
    const seeded = attribute(renderer, 'aPhase', 0)

    // A tab in the background, or a jump in the playback scrubber.
    renderer.update(frame([{ id: 5, speed: 1 }], { time: 30 }))
    expect(attribute(renderer, 'aPhase', 0)).toBeCloseTo(seeded + 0.5 * (1.9 + 1.15), 4)

    const after = attribute(renderer, 'aPhase', 0)
    renderer.update(frame([{ id: 5, speed: 1 }], { time: 10 }))
    // Scrubbing backwards holds the pose rather than walking in reverse.
    expect(attribute(renderer, 'aPhase', 0)).toBeCloseTo(after, 6)
  })

  it('gives a person the same body whatever slot they are in', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ id: 41 }, { id: 42 }]))
    const first = attribute(renderer, 'aSkin', 0)
    const second = attribute(renderer, 'aSkin', 1)

    // The shader indexes the skin table with this, so it has to land inside it.
    for (const sample of [first, second]) {
      expect(sample).toBeGreaterThanOrEqual(0)
      expect(sample).toBeLessThan(1)
    }
    // Two people standing together must not be issued the same body, or a
    // crowd reads as a row of clones.
    expect(first).not.toBeCloseTo(second, 3)

    renderer.update(frame([{ id: 42 }, { id: 41 }], { time: 0.2 }))
    // And nobody changes skin tone when the array compacts under them: the
    // sample is drawn from the person's id, not from the slot they occupy.
    expect(attribute(renderer, 'aSkin', 0)).toBe(second)
    expect(attribute(renderer, 'aSkin', 1)).toBe(first)
  })

  it('sits a seated person down and leaves everybody else standing', () => {
    const seated = AGENT_STATE_ORDER.indexOf('seated')
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ state: seated }, { state: AGENT_STATE_ORDER.indexOf('queuing') }]))
    expect(attribute(renderer, 'aPose', 0)).toBe(1)
    expect(attribute(renderer, 'aPose', 1)).toBe(0)
  })

  it('forgets people who have left so the gait table cannot grow without bound', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame(Array.from({ length: 300 }, (_, i) => ({ id: i }))))
    // A long run spawns and retires thousands of people through the same
    // renderer; the table is keyed by id and nothing else prunes it.
    const phases = (renderer as unknown as { phaseById: Map<number, number> }).phaseById
    expect(phases.size).toBe(300)

    renderer.update(frame([{ id: 1 }], { time: 1 }))
    expect(phases.size).toBe(1)

    // The prune is visible from outside, which is the cost of it: somebody the
    // renderer has forgotten and then sees again restarts from their id's seed
    // instead of continuing. That is the right trade — a person who has left
    // the venue is gone — but it is the behaviour, not an accident.
    renderer.update(frame([{ id: 7 }], { time: 1 }))
    expect(attribute(renderer, 'aPhase', 0)).toBeCloseTo((7 % 17) * 0.37, 5)

    renderer.clear()
    expect(phases.size).toBe(0)
  })
})

describe('colouring the crowd', () => {
  it('agrees with the legend about what each state looks like', () => {
    // Two hand-written tables, one for the instanced tint and one for the UI.
    // A legend that disagrees with the picture is worse than no legend.
    AGENT_STATE_ORDER.forEach((state, index) => {
      expect(STATE_COLORS[index]).toBe(AGENT_STATE_COLORS[state])
    })
    expect(STATE_COLORS).toHaveLength(AGENT_STATE_ORDER.length)
  })

  it('colours a person by what they are doing', () => {
    const renderer = new CrowdRenderer()
    const queuing = AGENT_STATE_ORDER.indexOf('queuing')
    renderer.update(frame([{ state: queuing }, { state: 99 }]))

    // A person is drawn in the colour the legend names. Decoding the hex twice
    // on the way into the buffer painted the queuing amber as #be5c0d, darker
    // and more saturated than the swatch beside it — and telling the picture
    // and the legend apart is the whole point of colouring by state.
    expect(STATE_COLORS[queuing]).toBe('#e0a23f')
    expect(tintOf(renderer, 0).getHexString()).toBe('e0a23f')
    // A state the renderer has no colour for still has to be drawn, in the
    // walking blue rather than in black.
    expect(STATE_COLORS[0]).toBe('#4c7dd4')
    expect(tintOf(renderer, 1).getHexString()).toBe('4c7dd4')
  })

  it('colours by population, wrapping round when there are more groups than colours', () => {
    const renderer = new CrowdRenderer()
    renderer.update(
      frame([{ population: 0 }, { population: 1 }, { population: POPULATION_COLORS.length + 1 }], {
        colorMode: 'population',
      }),
    )
    const [first, second, wrapped] = [0, 1, 2].map((i) => tintOf(renderer, i).getHexString())

    // Two groups sharing a room have to be told apart at a glance.
    expect(second).not.toBe(first)
    expect(second).toBe(asWritten(POPULATION_COLORS[1]))
    // A seventh population reuses a colour rather than reading past the end of
    // the table and drawing everybody in it black.
    expect(wrapped).toBe(second)
  })

  it('colours by profile, and falls back to the walking blue when the profile has gone', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ profile: 1 }, { profile: 99 }], { colorMode: 'profile' }))
    const hurried = tintOf(renderer, 0).getHexString()
    const missing = tintOf(renderer, 1).getHexString()
    expect(hurried).toBe(asWritten(AGENT_PROFILES[1].color))
    expect(missing).not.toBe(hurried)

    // A scenario edited mid-run can leave an index pointing at nothing. The
    // fallback is the same blue a walking person is drawn in, so the stray is
    // never given a colour that means something else on the legend.
    renderer.update(frame([{ state: 0 }], { colorMode: 'state', time: 1 }))
    expect(tintOf(renderer, 0).getHexString()).toBe(missing)
  })

  it('reads speed as green at free flow and red at a standstill', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ speed: 0 }, { speed: 1.34 }], { colorMode: 'speed' }))
    const stopped = tintOf(renderer, 0)
    const free = tintOf(renderer, 1)
    expect(stopped.r).toBeGreaterThan(free.r)
    expect(free.g).toBeGreaterThan(stopped.g)
    // Beyond free-flow speed the scale is already at its end.
    renderer.update(frame([{ speed: 3 }], { colorMode: 'speed', time: 1 }))
    expect(tintOf(renderer, 0).getHexString()).toBe(free.getHexString())
  })

  it('reads a long wait as a deepening red', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{ waited: 0 }, { waited: 150 }, { waited: 600 }], { colorMode: 'wait' }))
    const [fresh, waiting, stuck] = [0, 1, 2].map((i) => tintOf(renderer, i))
    expect(waiting.r).toBeGreaterThan(fresh.r)
    expect(stuck.r).toBeGreaterThan(waiting.r)
    // The scale tops out at five minutes; ten does not wrap round.
    expect(stuck.g).toBeLessThan(fresh.g)
  })
})

describe('picking a person', () => {
  const WIDTH = 800
  const HEIGHT = 600

  const camera = (): PerspectiveCamera => {
    const view = new PerspectiveCamera(50, WIDTH / HEIGHT, 0.1, 100)
    view.position.set(0, 0.9, 10)
    view.lookAt(0, 0.9, 0)
    view.updateMatrixWorld(true)
    return view
  }

  const screenOf = (view: PerspectiveCamera, x: number, z: number) => {
    const point = new Vector3(x, 0.9, z).project(view)
    return { x: (point.x * 0.5 + 0.5) * WIDTH, y: (-point.y * 0.5 + 0.5) * HEIGHT }
  }

  it('picks the person nearest the click, and nobody from empty floor', () => {
    const renderer = new CrowdRenderer()
    const view = camera()
    const agents = crowd([{ x: -2 }, { x: 0 }, { x: 2 }])
    const viewport = { width: WIDTH, height: HEIGHT }

    const target = screenOf(view, 2, 0)
    expect(renderer.pick(agents, 3, view, { x: target.x + 5, y: target.y + 5 }, viewport)).toBe(2)
    expect(renderer.pick(agents, 3, view, screenOf(view, 0, 0), viewport)).toBe(1)
    // Clicking the floor beside somebody deselects rather than grabbing them.
    expect(renderer.pick(agents, 3, view, { x: target.x + 40, y: target.y }, viewport)).toBeNull()
    // Unless the caller asks for a looser grab, for touch.
    expect(renderer.pick(agents, 3, view, { x: target.x + 40, y: target.y }, viewport, 60)).toBe(2)
  })

  it('never picks somebody standing behind the camera', () => {
    // Projection wraps behind the eye, so a person at your back lands under the
    // cursor with a perfect score.
    const renderer = new CrowdRenderer()
    const view = camera()
    const agents = crowd([
      { x: 0, y: 20 },
      { x: 0, y: 0 },
    ])
    expect(
      renderer.pick(agents, 2, view, screenOf(view, 0, 0), { width: WIDTH, height: HEIGHT }),
    ).toBe(1)
  })
})

describe('the character shader', () => {
  /** Run the material's injection over three's real standard shader. */
  const compile = () => {
    const renderer = new CrowdRenderer()
    const material = meshOf(renderer).material as MeshStandardMaterial
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: ShaderLib.standard.vertexShader,
      fragmentShader: ShaderLib.standard.fragmentShader,
    }
    material.onBeforeCompile!(shader as never, null as never)
    return { material, shader }
  }

  it('poses each limb after three has placed the vertex', () => {
    const { shader } = compile()
    // The injection hangs off chunk names. If a three upgrade renames one, the
    // replace silently does nothing and the whole crowd slides about frozen in
    // a T-pose — with no error anywhere to say so.
    expect(shader.vertexShader).toMatch(/#include <begin_vertex>\s+int limb = int\(aLimb/)
    expect(shader.vertexShader).toContain('vec3 rotateAboutX(')
    expect(shader.fragmentShader).toMatch(
      /#include <color_fragment>\s+diffuseColor\.rgb \*= vZoneColor/,
    )
  })

  it('declares the uniform arrays at the size the tables are', () => {
    const { shader } = compile()
    // Sampled with floor(t * n) in GLSL: a seventh skin tone added to the table
    // would never be picked, and a shorter table would read off the end.
    expect(shader.vertexShader).toContain(`uniform vec3 uSkinTones[${SKIN_TONES.length}];`)
    expect(shader.vertexShader).toContain(`uniform vec3 uPivots[${PIVOTS.length}];`)
    expect(shader.uniforms.uPivots.value).toHaveLength(PIVOTS.length)
    expect((shader.uniforms.uPivots.value as Vector3[])[1].toArray()).toEqual(PIVOTS[1])
  })

  it('keeps its own program cache key so the injection is not shared', () => {
    const { material } = compile()
    // Every standard material otherwise compiles to the same program; the
    // crowd would be handed somebody else's shader, or hand out its own.
    expect(material.customProgramCacheKey()).toBe('crowd-character-v1')
  })
})

describe('tearing down', () => {
  it('gives the character geometry and its program back', () => {
    const renderer = new CrowdRenderer()
    const mesh = meshOf(renderer)
    let freed = 0
    const count = () => {
      freed++
    }
    mesh.geometry.addEventListener('dispose', count)
    ;(mesh.material as MeshStandardMaterial).addEventListener('dispose', count)

    renderer.dispose()
    expect(freed).toBe(2)
    expect(renderer.group.children).toHaveLength(0)
  })

  it('hides the crowd without taking it apart', () => {
    const renderer = new CrowdRenderer()
    renderer.update(frame([{}, {}]))
    renderer.setVisible(false)
    expect(renderer.group.visible).toBe(false)
    // Still loaded, so turning the crowd back on costs nothing.
    expect(meshOf(renderer).count).toBe(2)
  })
})
