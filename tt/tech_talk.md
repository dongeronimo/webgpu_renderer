---

# What is real time volume rendering

- Its the process of converting volumetric data (textures 3d, texture arrays etc), into images, in real time.
- Real time means that the user can interact with it with decent speed (30fps+).
- That imposes constraints on volume rendering

# WebGPU
- A modern-ish graphical API that supercedes webgl.
- Looks a lot like a VERY simplified vulkan.
- Can be used in browsers or natively with rust or c++ libs.
  - We'll use in browser - Chromium based, most adherent to the standard.
- It can also be used for compute instead of graphics giving javascript webapps some serious number crunching power.
- Lacks capabilities that graphic programmers are used to rely on: 
  - Bindless
  - Other shaders beyond VS, FS and Compute
  - Async compute

#  Real Time Volume Rendering Techniques

- How do we do the real time volume rendering? 
- The best techquinque vary with the evolution of the hardware, the user requirements and the dataset.
- GPUs don't understand volume, they understand meshes (vertex shader, fragment shaders, etc). So we use workarounds using meshes to trigger the volumetric render algorithm or to fake volume.

# Texture stack:
- the 3d texture is "sliced" by many planes, rendered with blending on
- Old technique, was used in the 90s and early 2000s when the GPUs were weak and fixedfunction
- Bottleneck at the blending step and lots of fragments discarded, modern GPUs don'tlike this technique too much.
- Was the only way to offload work to GPU in the past.

# Volume Raymarch:
- Rays march thru the volume data, sampling the texture and accumulating the colour ofthe fragment.
- In the past was done CPU side, nowadays it's the default technique for volumerendering GPU side.
- Cost increases with the size of the data and the number of rays.
  - Rays depend on the amount of fragments and the amount of fragments depend on screensize and camera distance from the mesh.
- Fully paralelizable: Each ray is fully independent from each other.
  - Perfect for fragment shaders or compute shaders.
- Costs can grow very very fast, need optimizations   

# Constraints
- Quality x Space x Speed
- Can have 2 but not the three at the same time.
- Quality increases space costs somewhat (lookup tables, auxiliary textures) and Speed costs A LOT.
- Speed is acheived by doing less. To do less we need to sacrifice space using pre-calculated data or quality by actually doing less processing.
- Space matters because GPU memory is not infinite and data transfer has a cost
  - specially in mobile and web (our case here)
  
# Example of constraints - Gradient
- Gradient data is the rate of change of the image in a given point p.
- It gives us surface information: where the data is changing, and the surface of that change.
- It is either a vec3 (dX, dY, dZ) or a vec4 (dX, dY, dZ, mag)
- if the data is a scalar, lets say a f32, the gradient is 4x the size of the data.
- Calculating the gradient in runtime:
  - trade speed (8x texture fetches + triliear interpolations) for space (no need for a large texture to hold the gradients)
- Caching the gradient in a precalculated texture:
  - trade space (the gradient texture can be huge) for speed (1x texture fetch, all calculations already done).
- Or we could forego the gradient and quality (can't do lighting without gradients) for speed and space (no need for the gradient texture and zero texture fetches if no gradients).

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