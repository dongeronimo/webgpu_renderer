import { Camera } from "./camera";
import { loadGltf } from "./gltfLoader";
import { Mesh,  } from "./mesh";
import { World } from "./world";

export class TestWorld extends World {
    //guarda a lista de meshes
    private meshes:Mesh[] = [];
    
    async createWorld(perspective:{
        aspect:number, fovy:number, near:number, far:number
    }):Promise<void> {
        const {roots, nodes, meshes} = await loadGltf(this.device, "/models/test_world.glb");
        //So uma root. O resto do jogo assume que só tem uma root.
        this.meshes = meshes;
        roots.forEach(n => {
            this.rootNode.addChild(n);
        });
        //procura o nó da camera, pega o primeiro que achar
        const cams = nodes.filter(n=>n.name == "Camera");
        cams[0].camera = new Camera();
        cams[0].camera.aspect = perspective.aspect;
        cams[0].camera.near = perspective.near;
        cams[0].camera.far = perspective.far;
        cams[0].camera.fovY = perspective.fovy;
    }

}