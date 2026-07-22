# 1- Real Time Volume Rendering

## What is real time volume rendering

- Its the process of converting volumetric data (textures 3d, texture arrays etc), into images, in real time.
- Real time means that the user can interact with it with decent speed (30fps+).
- That imposes constraints on volume rendering
- [TODO Imagem de volume]

## Data
- Structured data: textures3d, texture arrays. The data is dense spatially. 
- Sparse data: Augmented Reality data points, fluids, scattered scientific data.
- The way the data is stored and what it represents matter because some techniques are better for one kind of data and worse for others
- For example, raymarchers are better for structured data while splatters are for sparse data

## Techniques
- Stack of slices 
  - Use the uvw texture coords to sample the 3d texture.
  - Relies on blending fixed function.
- Raymarcher
  - Marches along rays, sampling and accumulating the values. 
- Fourier volume rendering
  - Slices in frequency domain, projection in spatial domain. Very fast but can't do occlusion.
- Splatting
   - Projects each voxel on screen like a splatter (gaussian kernel or something like that) accumulating contributions. 
- We'll focus on Stack of Slices and Raymarcher.

# 2 - The complexities of volume rendering 

## Constraints
- Quality x Space x Speed
- Can have 2 but not the three at the same time.
- Quality increases space costs somewhat (lookup tables, auxiliary textures) and Speed costs A LOT.
- Speed is acheived by doing less. To do less we need to sacrifice space using pre-calculated data or quality by actually doing less processing.
- Space matters because GPU memory is not infinite and data transfer has a cost
  - specially in mobile and web (our case here)
- [TODO o triangulo das escolhas]

## Example of constraints - Gradient
- Gradient data is the rate of change of the image in a given point p.
- It gives us surface information - where the data is changing, and the surface of that change.
- It is either a vec3 (dX, dY, dZ) or a vec4 (dX, dY, dZ, mag)
- if the data is a scalar, lets say a f32, the gradient is 4x the size of the data.
- [TODO imagem de uma derivada parcial no r3]

## Gradient constraints
- Calculating the gradient in runtime -
  - trade speed (8x texture fetches + triliear interpolations) for space (no need for a large texture to hold the gradients)
- Caching the gradient in a precalculated texture -
  - trade space (the gradient texture can be huge) for speed (1x texture fetch, all calculations already done).
- Or we could forego the gradient and quality (can't do lighting without gradients) for speed and space (no need for the gradient texture and zero gradient texture fetches if no gradients).
- [TODO 2 imagens, uma minha com gradient on outra com gradient off]

## Where we'll pay the price?
- Slice stacks pay the price on the blender fixed function
- Raymarchers and splatters pay on the fragment or compute shader.
- Fourier are lighting fast but can't do occlusion.
- Preprocessing pay on the CPU, on the memory transfer to the GPU (if the data was processed in the CPU) or in the compute shader (if the data was processed in the GPU).

## Issues we need to take care of
- Sampling artifacts
  - caused by undersampling, generate an onion ring pattern. More samples mitigate but at cost of speed.
  - TODO: imagem de comparação entre as qtds de fatias
  - some ways to "cheat" like ray jitter, to disguise the pattern
- Differences between hardware
  - in some platforms some operations are cheap, in other they are expensive. 
  - Example: texture fetch cost in desktop x mobile

## Pre-integration (Engel, Kraus, Ertl 2001)
- The principled fix for the onion ring: thin transfer-function features that fall BETWEEN two samples are simply skipped by a pointwise lookup.
- Key move: a "slab" is the ray segment between two consecutive samples — use the PAIR (front value sf, back value sb), not a single point.
- Precompute a 2D table T[sf][sb] = the transfer function INTEGRATED over the linear ramp sf→sb, baked from the CTF (not per frame). The diagonal sf==sb is just the old pointwise lookup.
- Render time: sample the volume twice (this slice + one step deeper), and ONE 2D lookup replaces the pointwise CTF lookup — already integrated, nothing to composite in-slab.
- Payoff: few slices look as crisp as many. Cost: +1 texture fetch and rebaking the table only when the CTF changes.
  - TODO: imagem comparativa — poucas fatias, com e sem pré-integração

---
# Techniques
##  Real Time Volume Rendering Techniques
- How do we do the real time volume rendering? 
- The best techquinque vary with the evolution of the hardware, the user requirements and the dataset.
- GPUs don't understand volume, they understand meshes (vertex shader, fragment shaders, etc). So we use workarounds using meshes to trigger the volumetric render algorithm or to fake volume.

## Image composition
- Volume data: may be the actual colour or may be data that is used to generate the colour.
- To see deep into the volume we need to somehow integrate the samples along a direction to do the illusion of
  volume in a 3d mesh.   

## Texture stack (Texture-based slicing):
- the 3d texture is "sliced" by many planes, rendered with blending on
- Uses the blender fixed function step to integrate the ray.
- Older technique, still relevant because it's fast.
- Shadows and other image improvements are much harder in it then in raymarchers
- Can't do some optimizations that come naturally to raymarching
  - early ray termination
  - empty space skipping
- Bottleneck at the blending step and lots of fragments discarded.

## Texture Stack (Texture-based slicing) cont.
- [TODO image of the stacks]
- Stacks can be either axis-aligned or view aligned (aligned to the camera forward)
- The 1st case is simpler but generates artifacts when you change which AA stack you see
- The 2nd case constantly recalculates the stack's meshes, intersecting then with a bounding box.
  - Upload cost small in today GPUs, but it is there
   

## Volume Raymarch:
- Rays march thru the volume data, sampling the texture and accumulating the colour ofthe fragment.
- In the past was done CPU side, nowadays it's the default technique for volumerendering GPU side.
- Cost increases with the size of the data and the number of rays.
  - Rays depend on the amount of fragments and the amount of fragments depend on screensize and camera distance from the mesh.
- Fully paralelizable - Each ray is fully independent from each other.
  - Perfect for fragment shaders or compute shaders.
- Costs can grow very very fast, need optimizations   

## Similarities bewtween them
- Texture-based slicing IS a raymarcher.
- Instead of writing the shader and do the march on the fragment we draw the slices and compose the rays using the fixed function blender
- The ray is implicit.
- With the exception of Fourier-Based techiniques all volume rendering in compact data equates to raymarching with different forms.
  - The differences MATTER.

---
# Case study - shading the smoke scene

## Surfaces x participating media
- In medical data (CT) lighting comes from the GRADIENT: density transitions act like surfaces, the gradient is the normal, classic surface shading applies.
- Smoke has no surface to shade: it's a participating MEDIUM. A smooth advected density field has no useful gradient/normal.
- What gives the "look of smoke" is answering: how much SUNLIGHT arrives alive at each sample?
- So the right tool for media is raymarching TOWARDS THE LIGHT and accumulating — not gradients.
- [TODO imagem: CT com gradient shading ao lado da cena de fumaça]

## Smoke shading (single scattering)
- At each dense sample of the primary march, a SECOND march towards the sun accumulates optical depth τ → T = exp(-τ). Same Beer-Lambert of the eye ray, now along the light direction = self-shadowing.
- The light march can be much coarser than the eye march (smoke shadows are soft by nature), with early-out once τ already means total shadow.
- Geometry also shadows the smoke: 1 shadow map tap per sample.
- Henyey-Greenstein phase function: preferential FORWARD scattering → "silver lining" when backlit. Directional sun ⇒ constant per pixel, computed once outside the loop.
- No multiple scattering (too expensive for real time): a constant AMBIENT floor fakes it — real smoke bounces light internally; without the floor the shadowed side turns pitch black.
- [TODO screenshot da fumaça iluminada: lado do sol claro, barriga escura, contraluz pro silver lining]

## The smoke shadows the scene too
- Same idea in reverse: a light-space TRANSMITTANCE map, aligned with the sun's shadow map.
- Per texel, march the smoke along the sun ray and store T = exp(-τ); geometry multiplies its direct light by T.
- Soft gray shadow, not binary — and multiple smoke sources compose by product (T1·T2·...).
- The triangle again: shading the medium costs a 2nd march per sample, the cast shadow costs one more 2D map — speed bought with space and less quality (single scattering + tricks, not the full physics).
- [TODO screenshot da sombra da fumaça projetada no chão/objeto]

--- 
# Extras

# WebGPU
- Very simple "modern" gpu library for the browsers. 
- Just a device, a queue and a command encoder.
- Pipelines and render passes.
- It abstracts upload to the GPU.
- It synchronizes the data dependencies for us;
- Ease of use x Power
  - It's far simpler then either Vulkan, dx12 or even dx11.
  - That comes at a cost: much less control over synchronization and data upload.
- Good enough for our proposes here.  