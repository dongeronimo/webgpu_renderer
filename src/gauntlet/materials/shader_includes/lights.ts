/// Define os dados dos 3 tipos de luz: Point, Spot e Directional
export const LIGHT_STRUCTS = `struct PointLight {
    position: vec3f,
    intensity: f32,
    color: vec3f,
    _pad0: f32,
};
struct SpotLight {
    position: vec3f,
    intensity: f32,
    direction: vec3f,
    cosOuter: f32,
    color: vec3f,
    cosInner: f32,
    shadowViewProj: mat4x4f,
    //3 escalares, NÃO um vec3f: vec3f exige alinhamento de 16 bytes e
    //empurraria o campo (e o tamanho do struct inteiro) 12 bytes adiante,
    //dessincronizando do stride calculado no lado da CPU (FLOATS_PER_SPOT).
    shadowIndex: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};
struct DirectionalLight {
    direction: vec3f,
    intensity: f32,
    color: vec3f,
    shadowIndex: f32,
    shadowViewProj: mat4x4f,
};`;
/// Os buffers com os dados de luz ficam no group 0, binding 1,2,3, na ordem pointLights,
/// spot lights, directionaLights.
export const BIND_GROUP_0_LIGHT_SETS = `
@group(0) @binding(1) var<storage, read> pointLights: array<PointLight>;
@group(0) @binding(2) var<storage, read> spotLights: array<SpotLight>;
@group(0) @binding(3) var<storage, read> directionalLights: array<DirectionalLight>;
`

