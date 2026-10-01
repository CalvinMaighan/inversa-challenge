/**
 * The seven looks of the globe (docs/GODS_EYE.md GC2), after the God's Eye View presets, as fragment shaders for
 * Cesium `PostProcessStage`s. `normal` has no shader. Every other preset reads the scene from `colorTexture`,
 * builds its styled colour and mixes it in by `intensity` (0..1), which the crossfade drives; `time` (seconds)
 * animates the ones marked `animated`.
 *
 * Written for novices and for the sightings on top of the globe: the effects keep luminance contrast so a
 * marker (a bright icon over a dark outline) stays readable, pixel cells are 2 px at most, and every pass is a
 * handful of texture taps so a software renderer keeps up.
 */
import type { LookId } from "client/state/look";

export type LookPreset = {
  id: LookId;
  /** Button label in the Look popover. */
  label: string;
  /** One line for the button title and the help sheet. */
  blurb: string;
  /** Fragment shader, or null for the untouched scene. */
  fragmentShader: string | null;
  /** Needs frames while active (noise, flakes, flicker). */
  animated: boolean;
};

/** Every shader shares the stage's inputs and the two uniforms the look module drives. */
const PRELUDE = /* glsl */ `
uniform sampler2D colorTexture;
uniform vec2 colorTextureDimensions;
uniform float intensity;
uniform float time;
in vec2 v_textureCoordinates;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float hash21(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.y);
}
`;

const CRT = /* glsl */ `${PRELUDE}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 dims = colorTextureDimensions;
  vec3 src = texture(colorTexture, uv).rgb;
  // A slight bulge, as on glass: push the sample point outwards with the square of the radius.
  vec2 c = uv * 2.0 - 1.0;
  float r2 = dot(c, c);
  vec2 cuv = (c * (1.0 + 0.04 * r2)) * 0.5 + 0.5;
  float inside = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
  // 2 px cells and a colour split that grows towards the corners.
  vec2 cell = (floor(cuv * dims * 0.5) * 2.0 + 1.0) / dims;
  vec2 split = c * 0.002 * r2;
  vec3 col = vec3(texture(colorTexture, cell + split).r, texture(colorTexture, cell).g, texture(colorTexture, cell - split).b);
  col = floor(col * 14.0 + 0.5) / 14.0;
  // Every other device row darker, a slow rolling bright band, and a 60 Hz shimmer.
  float row = cuv.y * dims.y;
  float scan = 0.80 + 0.20 * step(1.0, mod(row, 2.0));
  float band = 1.0 + 0.06 * smoothstep(0.06, 0.0, abs(fract(cuv.y + time * 0.07) - 0.5));
  float shimmer = 0.975 + 0.025 * sin(time * 377.0);
  col *= vec3(1.0, 0.97, 0.88) * scan * band * shimmer;
  col *= (1.0 - 0.3 * r2 * r2) * inside;
  out_FragColor = vec4(mix(src, col, intensity), 1.0);
}
`;

const NVG = /* glsl */ `${PRELUDE}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 dims = colorTextureDimensions;
  vec2 px = 3.0 / dims;
  vec3 src = texture(colorTexture, uv).rgb;
  float l = dot(src, LUMA);
  // Two taps on a diagonal 3 px out: bright spots bleed into a halo, as through an intensifier tube. Two, not
  // a cross of four, so a software renderer keeps the frame within 1.5x of normal (gates/leaf-GE2.md G6).
  float around = dot(texture(colorTexture, uv + px).rgb, LUMA) + dot(texture(colorTexture, uv - px).rgb, LUMA);
  float halo = smoothstep(0.3, 1.0, around * 0.5);
  float gain = clamp(l * 2.0, 0.0, 1.0);
  gain = gain * (2.0 - gain);
  float v = gain + halo * 0.3;
  // Scintillation: per-pixel sparkle, stronger in the dark.
  float n = hash21(uv * dims + fract(time * 0.37) * vec2(37.0, 91.0)) - 0.5;
  v += n * (0.12 - 0.08 * gain);
  vec3 col = vec3(0.32, 1.0, 0.42) * v;
  col *= 0.94 + 0.06 * step(1.0, mod(uv.y * dims.y, 2.0));
  // The tube: a soft circular falloff, the middle untouched.
  vec2 c = (uv - 0.5) * vec2(dims.x / dims.y, 1.0);
  col *= 1.0 - 0.6 * smoothstep(0.55, 1.15, length(c));
  out_FragColor = vec4(mix(src, col, intensity), 1.0);
}
`;

const FLIR = /* glsl */ `${PRELUDE}
// Cold to hot: black, violet, magenta, red, orange, yellow, white.
vec3 ironbow(float t) {
  t = clamp(t, 0.0, 1.0) * 6.0;
  vec3 k0 = vec3(0.0);
  vec3 k1 = vec3(0.14, 0.0, 0.32);
  vec3 k2 = vec3(0.52, 0.0, 0.48);
  vec3 k3 = vec3(0.88, 0.12, 0.16);
  vec3 k4 = vec3(1.0, 0.56, 0.0);
  vec3 k5 = vec3(1.0, 0.92, 0.36);
  vec3 k6 = vec3(1.0);
  if (t < 1.0) return mix(k0, k1, t);
  if (t < 2.0) return mix(k1, k2, t - 1.0);
  if (t < 3.0) return mix(k2, k3, t - 2.0);
  if (t < 4.0) return mix(k3, k4, t - 3.0);
  if (t < 5.0) return mix(k4, k5, t - 4.0);
  return mix(k5, k6, t - 5.0);
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 dims = colorTextureDimensions;
  vec2 px = 1.0 / dims;
  vec3 src = texture(colorTexture, uv).rgb;
  // Infrared is soft: the pixel and its two diagonal neighbours.
  float l = dot(src, LUMA) * 0.5
    + dot(texture(colorTexture, uv + px).rgb, LUMA) * 0.25
    + dot(texture(colorTexture, uv - px).rgb, LUMA) * 0.25;
  float heat = pow(clamp((l - 0.03) / 0.85, 0.0, 1.0), 0.8);
  heat += (hash21(uv * dims + fract(time * 0.23) * vec2(53.0, 17.0)) - 0.5) * 0.04;
  vec3 col = ironbow(heat);
  vec2 c = uv - 0.5;
  col *= 1.0 - 0.25 * dot(c, c) * 2.0;
  out_FragColor = vec4(mix(src, col, intensity), 1.0);
}
`;

const NOIR = /* glsl */ `${PRELUDE}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 dims = colorTextureDimensions;
  vec3 src = texture(colorTexture, uv).rgb;
  float l = dot(src, LUMA);
  // Contrast around the sea's brightness (a map is mostly dark water), then film grain and a dark edge.
  float v = clamp((l - 0.3) * 1.5 + 0.4, 0.0, 1.0);
  v = v * v * (3.0 - 2.0 * v);
  v += (hash21(uv * dims + vec2(7.0, 3.0)) - 0.5) * 0.06;
  vec2 c = uv - 0.5;
  float vig = 1.0 - 0.7 * smoothstep(0.2, 0.8, length(c * vec2(dims.x / dims.y, 1.0)));
  vec3 col = vec3(0.93, 0.95, 1.02) * v * vig;
  out_FragColor = vec4(mix(src, col, intensity), 1.0);
}
`;

const ANIME = /* glsl */ `${PRELUDE}
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 dims = colorTextureDimensions;
  vec2 px = 1.0 / dims;
  vec3 src = texture(colorTexture, uv).rgb;
  float l = dot(src, LUMA);
  // Cel shading: six brightness bands, colour kept, saturation up.
  float q = floor(l * 6.0 + 0.5) / 6.0;
  vec3 col = src * (q / max(l, 0.002));
  col = mix(vec3(dot(col, LUMA)), col, 1.5);
  // Ink lines where brightness changes between neighbours.
  float gx = dot(texture(colorTexture, uv + vec2(px.x, 0.0)).rgb, LUMA) - dot(texture(colorTexture, uv - vec2(px.x, 0.0)).rgb, LUMA);
  float gy = dot(texture(colorTexture, uv + vec2(0.0, px.y)).rgb, LUMA) - dot(texture(colorTexture, uv - vec2(0.0, px.y)).rgb, LUMA);
  float edge = smoothstep(0.08, 0.3, abs(gx) + abs(gy));
  col *= 1.0 - 0.65 * edge;
  col = clamp(col * vec3(1.04, 1.0, 0.94), 0.0, 1.0);
  out_FragColor = vec4(mix(src, col, intensity), 1.0);
}
`;

const SNOW = /* glsl */ `${PRELUDE}
float flakes(vec2 uv, float layer) {
  vec2 dims = colorTextureDimensions;
  float scale = 16.0 + layer * 9.0;
  vec2 p = uv * vec2(dims.x / dims.y, 1.0) * scale;
  p.y += time * (0.5 + layer * 0.35);
  p.x += sin(time * 0.4 + layer * 2.1) * 0.4;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  // Not every cell holds a flake, so they fall as a scatter rather than a grid.
  float present = step(0.6, hash21(cell * 1.7 + 3.3 + layer));
  vec2 centre = 0.2 + 0.6 * vec2(hash21(cell + layer * 11.0), hash21(cell + 5.0 + layer * 7.0));
  float d = length(f - centre);
  return present * smoothstep(0.08, 0.02, d) * (0.4 + 0.25 * layer);
}
void main() {
  vec2 uv = v_textureCoordinates;
  vec3 src = texture(colorTexture, uv).rgb;
  float l = dot(src, LUMA);
  // A cold cast, half the colour gone, frost on the bright parts, flakes in three depths, haze below.
  vec3 col = src * vec3(0.86, 0.92, 1.08);
  col = mix(col, vec3(l), 0.35);
  col = mix(col, vec3(0.92, 0.95, 1.0), 0.14 + 0.22 * smoothstep(0.3, 0.8, l));
  col += (flakes(uv, 0.0) + flakes(uv, 1.0) + flakes(uv, 2.0)) * 0.8;
  col = mix(col, vec3(0.85, 0.88, 0.95), 0.12 * smoothstep(0.45, 0.0, uv.y));
  out_FragColor = vec4(mix(src, clamp(col, 0.0, 1.0), intensity), 1.0);
}
`;


export const LOOK_PRESETS: readonly LookPreset[] = [
  { id: "normal", label: "Normal", blurb: "The map as it is", fragmentShader: null, animated: false },
  { id: "crt", label: "CRT", blurb: "An old monitor: scanlines, glass curve, colour fringes", fragmentShader: CRT, animated: true },
  { id: "nvg", label: "NVG", blurb: "Night vision: phosphor green with a sparkle", fragmentShader: NVG, animated: true },
  { id: "flir", label: "FLIR", blurb: "Thermal camera: cold is dark, hot is white", fragmentShader: FLIR, animated: true },
  { id: "noir", label: "Noir", blurb: "Black and white film with grain", fragmentShader: NOIR, animated: false },
  { id: "anime", label: "Anime", blurb: "Flat colour bands and ink lines", fragmentShader: ANIME, animated: false },
  { id: "snow", label: "Snow", blurb: "A cold cast with falling flakes", fragmentShader: SNOW, animated: true },
];

export const lookPreset = (id: LookId): LookPreset => LOOK_PRESETS.find((p) => p.id === id)!;
