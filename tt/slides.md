# Slides — Real Time Volume Rendering

> Formato: título + até 5 bullets por slide. As linhas `🖼️` são notas minhas (sugestão de imagem, não vão pro slide).
> Slides em inglês, seguindo o idioma do tech_talk.md — se quiser em pt-BR é só pedir.

---

## Slide 1 — Real Time Volume Rendering

- (título, seu nome, data)
- From CT scans to smoke — volume rendering in the browser with WebGPU

🖼️ **Imagem:** screenshot "hero" do seu renderer — o CT de abdômen no `textureStackVolumeRenderCT` (ou raycast) com uma CTF bonita, ocupando o slide inteiro atrás do título.

---

## Slide 2 — What is real-time volume rendering?

- Converting volumetric data (3D textures, texture arrays…) into images — in real time.
- "Real time" = the user can interact with it at decent speed (30 fps+).
- That interactivity requirement imposes hard constraints on everything we do.
- Every technique in this talk is shaped by those constraints.

🖼️ **Imagem:** um volume renderizado (screenshot do seu CT). Se quiser contexto extra: uma foto de fatia de tomografia ao lado, mostrando "de onde vem" o dado.

---

## Slide 3 — The data

- Structured data: 3D textures, texture arrays — spatially dense grids.
- Sparse data: AR point clouds, fluids, scattered scientific data.
- How the data is stored — and what it represents — drives the choice of technique.
- Example: raymarchers fit structured data; splatting fits sparse data.

🖼️ **Imagem:** diagrama lado a lado — grade de voxels densa vs. nuvem de pontos esparsa. Fácil de desenhar (dois cubos: um preenchido com gridzinho, outro com pontinhos espalhados).

---

## Slide 4 — The technique zoo

- Stack of slices: sample the 3D texture via uvw coords, let fixed-function blending integrate.
- Raymarching: march rays through the volume, sampling and accumulating.
- Fourier volume rendering: slices in frequency domain — very fast, but can't do occlusion.
- Splatting: project each voxel as a (gaussian) kernel on screen, accumulate contributions.
- Today we'll focus on **stack of slices** and **raymarching**.

🖼️ **Imagem (opcional):** 4 mini-ícones/thumbnails, um por técnica. Se der trabalho, pode ficar sem imagem — o slide seguinte compensa.

---

# Section — The complexities of volume rendering

---

## Slide 5 — The triangle: Quality × Space × Speed

- Pick two. You never get all three.
- Quality costs some space (lookup tables, auxiliary textures); Speed costs A LOT.
- Speed = doing less. To do less: pay space (precalculated data) or pay quality (less processing).
- Space matters: GPU memory is finite and transfers have a cost…
- …especially on mobile and the web — our case here.

🖼️ **Imagem:** o "triângulo das escolhas" — triângulo com Quality / Space / Speed nos vértices, estilo "good-fast-cheap". Desenhe você mesmo (Excalidraw/PowerPoint resolve em 2 min).

---

## Slide 6 — Case study: the gradient

- Gradient = rate of change of the data at a point *p*.
- It gives us **surface** information: where the data changes, and the orientation of that change.
- Stored as vec3 (dX, dY, dZ) or vec4 (dX, dY, dZ, magnitude).
- If the data is a scalar f32, the gradient is **4× the size of the data**.

🖼️ **Imagem:** ilustração de derivada parcial / setas de gradiente sobre um campo escalar em R³ (ex.: esfera com vetores normais apontando pra fora). Dá pra desenhar ou pegar figura clássica de livro-texto.

---

## Slide 7 — Gradient: pick your poison

- Compute at runtime → trade **speed** (8 texture fetches + trilinear interpolations) for space.
- Precompute into a texture → trade **space** (the gradient texture can be huge) for speed (1 fetch).
- Skip it entirely → trade **quality** (no lighting without gradients) for speed AND space.
- Same feature, three positions on the triangle.

🖼️ **Imagem:** duas screenshots suas, lado a lado — raycast world com gradient/lighting ON vs. OFF, mesma câmera e mesma CTF. É o par de imagens mais convincente da talk.

---

## Slide 8 — Where do we pay the price?

- Slice stacks: at the fixed-function blender.
- Raymarchers and splatters: in the fragment or compute shader.
- Fourier: lightning fast — but no occlusion, ever.
- Preprocessing: on the CPU + memory transfer, or in a compute shader if done GPU-side.
- And the price varies by hardware: e.g. texture fetch cost on desktop vs. mobile.

---

## Slide 9 — Sampling artifacts

- Undersampling generates the classic "onion ring" / wood-grain pattern.
- More samples mitigate it — at the cost of speed (the triangle again).
- There are ways to "cheat": ray jitter turns the rings into noise, which eyes forgive.

🖼️ **Imagem:** `tt/texture_based_vr_sampling_artifacts.png` (já existe!). Ideal: complementar com uma segunda screenshot com mais fatias, mesma câmera, pra comparação poucas × muitas fatias.

---

## Slide 10 — Pre-integration (Engel, Kraus, Ertl — 2001)

- The *principled* fix for onion rings: thin transfer-function features that fall **between** two samples are simply skipped by a pointwise lookup.
- Key move: think in **slabs** — the ray segment between two consecutive samples, described by the pair (s_front, s_back), not a single point.
- Precompute a 2D table: T[sf][sb] = transfer function **integrated** over the linear ramp sf→sb.
- Baked from the CTF, not per frame; the diagonal sf == sb is just the old pointwise lookup.

🖼️ **Imagem:** diagrama de um raio com dois samples consecutivos marcando o slab (sf, sb) e a feature fininha da CTF caindo no meio. Desenhável; a figura equivalente do paper do Engel serve de referência.

---

## Slide 11 — Pre-integration at render time

- Sample the volume **twice**: this slice + one step deeper.
- **One** 2D table lookup replaces the pointwise CTF lookup — the integral is already done.
- Payoff: few slices look as crisp as many.
- Cost: +1 texture fetch, and rebaking the table only when the CTF changes.

🖼️ **Imagem:** comparação com POUCAS fatias, com e sem pré-integração — mesma câmera, mesma CTF, mesmo número de fatias. Você tem isso implementado no `textureStackVolumeRenderCT`; é o "money shot" da talk.

---

# Section — Techniques

---

## Slide 12 — GPUs don't understand volumes

- The best technique varies with hardware evolution, user requirements and the dataset.
- GPUs understand **meshes**: vertex shaders, fragment shaders, rasterization.
- So we use mesh workarounds to trigger — or fake — the volumetric algorithm.
- The core problem: integrate samples along the view direction to create the illusion of depth.
- The volume data may be the actual colour, or data used to *generate* the colour (CTF).

---

## Slide 13 — Texture-based slicing

- Slice the 3D texture with many planes, rendered with blending ON.
- The fixed-function blender integrates the ray for us.
- Older technique — still relevant, because it's fast.
- Shadows and quality improvements are much harder here than in raymarchers.
- Misses optimizations that come naturally to raymarching: early ray termination, empty-space skipping. Bottleneck at blending + lots of discarded fragments.

🖼️ **Imagem:** screenshot do seu `textureStackVolumeRenderCT`, de preferência com o debug de slices visível se você tiver (senão a render normal).

---

## Slide 14 — Slicing: axis-aligned vs. view-aligned

- Axis-aligned: 3 static stacks, pick per dominant axis — simple, but "pops" when the active stack switches.
- View-aligned: planes perpendicular to the camera forward, re-intersected with the bounding box every frame.
- Recomputing meshes has an upload cost — small on today's GPUs, but it's there.

🖼️ **Imagem:** diagrama clássico dos dois casos — cubo com fatias alinhadas aos eixos vs. cubo com fatias perpendiculares à câmera (com o frustum/olho desenhado). Figura equivalente existe no livro *Real-Time Volume Graphics*; fácil de redesenhar.

---

## Slide 15 — Volume raymarching

- Rays march through the volume, sampling the texture and accumulating colour.
- Was CPU-side in the past; today it's the *default* GPU technique.
- Cost grows with data size × number of rays — and rays depend on fragments, i.e. screen size + camera distance.
- Embarrassingly parallel: every ray is independent — perfect for fragment or compute shaders.
- Costs grow very, very fast ⇒ optimizations are mandatory.

🖼️ **Imagem:** screenshot do seu `raycastWorld`. Bônus: o `raycastESSWorld` com o debug de chunks ligado (`debugChunksPass`) ilustra empty-space skipping de forma linda — vale um slide-bônus ou um "aside" aqui.

---

## Slide 16 — Plot twist: slicing IS raymarching

- Texture-based slicing *is* a raymarcher — the blender composites, and the ray is implicit.
- Instead of marching in a shader, we draw slices and let the fixed function integrate.
- Except for Fourier techniques, all volume rendering on compact data equates to raymarching in different forms.
- But the differences MATTER: where you pay the price, and which optimizations you can reach.

---

# Section — Case study: the smoke scene

---

## Slide 17 — Shading a volume: surfaces vs. media

- In medical data (CT), lighting comes from the **gradient**: density transitions act like surfaces, the gradient is the normal, classic surface shading applies.
- Smoke has no surface to shade: it's a **participating medium**.
- A smooth, advected density field has no useful gradient/normal anywhere.
- What gives the "look of smoke" is answering: *how much sunlight arrives alive at each sample?*
- The right tool for media: raymarch **towards the light** and accumulate — not gradients.

🖼️ **Imagem:** par lado a lado — o CT com gradient shading (slide 7 reaproveitado) vs. screenshot da cena de fumaça do `gameVolume`. É o contraste central do slide.

---

## Slide 18 — Smoke shading = single scattering

- At each dense sample of the primary march, a **second march towards the sun** accumulates optical depth τ → T = exp(−τ): self-shadowing, same Beer-Lambert as the eye ray, now along the light.
- The light march can be much coarser than the eye march — smoke shadows are soft by nature — with early-out once τ already means total shadow.
- Geometry shadows the smoke too: one shadow-map tap per sample.
- Henyey-Greenstein phase: preferential forward scattering → the backlit "silver lining". Directional sun ⇒ constant per pixel, computed once.
- No multiple scattering (too expensive): a constant **ambient floor** fakes it — real smoke bounces light internally; without it the shadowed side turns pitch black.

🖼️ **Imagem:** screenshot do `gameVolume` com o sol de lado: topo/lado do sol claro, "barriga" escura. Bônus forte: uma segunda em contraluz mostrando o silver lining, e/ou uma com ambient = 0 pra justificar o truque.

---

## Slide 19 — The smoke shadows the scene too

- Same idea in reverse: a light-space **transmittance map**, aligned with the sun's shadow map.
- Per texel: march the smoke along the sun ray, store T = exp(−τ).
- Geometry multiplies its direct light by T — a soft, gray shadow, not a binary one.
- Multiple smoke sources compose by product: T₁ · T₂ · …
- The triangle again: a 2nd march per sample + one more 2D map — speed bought with space, and quality capped at single scattering + tricks.

🖼️ **Imagem:** screenshot da sombra da fumaça projetada no chão/no objeto da cena (dá pra ver que é cinza e suave, não dura como a do shadow map).

---

## Slide 20 — Extra: WebGPU

- Very simple "modern" GPU API for browsers: a device, a queue, a command encoder — pipelines and render passes.
- It abstracts uploads to the GPU and synchronizes data dependencies for us.
- Ease of use × power: far simpler than Vulkan, DX12, or even DX11…
- …at the cost of much less control over synchronization and data upload.
- Good enough for our purposes here.

---

## Slide 21 — Demo + references

- Live demo: CT volume, CTF editor, slicing × raymarching, pre-integration toggle, smoke scene (dynamic volume + shading).
- Engel, Kraus, Ertl — *High-Quality Pre-Integrated Volume Rendering Using Hardware-Accelerated Pixel Shading* (2001).
- *Real-Time Volume Graphics* — Engel et al. (the reference book on all of this).
- (contato / repo / perguntas)

🖼️ **Imagem:** nenhuma — aqui a imagem é a demo ao vivo. Se quiser um plano B contra demo-effect: um GIF/vídeo curto gravado do renderer girando o volume.
