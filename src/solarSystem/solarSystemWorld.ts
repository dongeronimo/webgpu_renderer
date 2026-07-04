
import { Camera } from "../camera";
import { loadGltf } from "../gltfLoader";
import { registerMaterial, UnshadedOpaque } from "../material";
import { Mesh } from "../mesh";
import { World } from "../world";

export class SolarSystem extends World {
    public meshes:Mesh[] = [];

    async createWorld(perspective: { aspect: number; fovy: number; near: number; far: number; }): Promise<void> {
        registerMaterial("sun", new UnshadedOpaque(this.device, [1.0, 0.8,0,1]));
        registerMaterial("terra", new UnshadedOpaque(this.device, [0.2, 0.4, 1.0, 1]));
        registerMaterial("moon", new UnshadedOpaque(this.device, [0.4, 0.4, 0.4, 1]));
        const {roots, nodes} = await loadGltf(this.device, "/models/solar_system.glb");
        //só uma root
        roots.forEach(n=>{
            this.rootNode.addChild(n);
        });
        //atribui material
        this.meshes = this.meshes;
        //procura o nó da camera, pega o primeiro que achar
        const cams = nodes.filter(n=>n.name == "Camera");
        cams[0].camera = new Camera();
        cams[0].camera.aspect = perspective.aspect;
        cams[0].camera.near = perspective.near;
        cams[0].camera.far = perspective.far;
        cams[0].camera.fovY = perspective.fovy;
    }

}
