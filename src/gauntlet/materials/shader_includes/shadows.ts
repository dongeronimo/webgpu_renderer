
export const SHADOW_FACTOR = `
fn sampleShadowPCF(map: texture_depth_2d_array, layer: i32, uv: vec2f, refDepth: f32) -> f32 {
    let dims = textureDimensions(map);
    let texel = 1.0 / vec2f(f32(dims.x), f32(dims.y));
    var sum = 0.0;
    for (var dx = -1; dx <= 1; dx = dx + 1) {
        for (var dy = -1; dy <= 1; dy = dy + 1) {
            sum = sum + textureSampleCompareLevel(map, shadowSampler, uv + vec2f(f32(dx), f32(dy)) * texel, layer, refDepth);
        }
    }
    return sum / 9.0;
}

fn shadowFactor(worldPos: vec3f, shadowViewProj: mat4x4f, shadowIndex: f32, map: texture_depth_2d_array) -> f32 {
    let clip = shadowViewProj * vec4f(worldPos, 1.0);
    if (clip.w <= 0.0) {
        return 1.0;
    }
    let ndc = clip.xyz / clip.w;
    if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < 0.0 || ndc.z > 1.0) {
        return 1.0;
    }
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    return sampleShadowPCF(map, i32(shadowIndex), uv, ndc.z);
}`;