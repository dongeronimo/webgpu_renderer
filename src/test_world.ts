import { Camera } from "./camera";
import { FinalRenderPass } from "./finalPass";
import { loadGltf } from "./gltfLoader";
import { UnshadedOpaque } from "./material";
import { Mesh,  } from "./mesh";
import { MeshRenderPass } from "./meshPass";
import { World } from "./world";

export class TestWorld extends World {
    //guarda a lista de meshes
    public meshes:Mesh[] = [];

    private red:UnshadedOpaque|undefined=undefined;

    //Criados no createRenderPasses (o main chama antes do createWorld)
    private meshPass!: MeshRenderPass;
    private finalPass!: FinalRenderPass;
    private canvas!: HTMLCanvasElement;

    createRenderPasses(canvas: HTMLCanvasElement, canvasFormat: GPUTextureFormat): void {
        this.canvas = canvas;
        this.finalPass = new FinalRenderPass(this.device, canvas, canvasFormat);
        this.meshPass = new MeshRenderPass(this.device, canvasFormat);
    }

    render(encoder: GPUCommandEncoder): void {
        this.finalPass.resizeIfNeeded();
        this.meshPass.render(encoder, this.rootNode, this.canvas.width, this.canvas.height);
        this.finalPass.render(encoder, this.meshPass.colorView);
    }

    override destroy(): void {
        super.destroy();
        //o red não passa pelo registry, então a base não o pega
        this.red?.destroy();
        for (const mesh of this.meshes) {
            mesh.destroy();
        }
        this.meshes = [];
        this.meshPass.destroy();
        this.finalPass.destroy();
    }

    async createWorld(perspective:{
        aspect:number, fovy:number, near:number, far:number
    }):Promise<void> {
        const {roots, nodes, meshes} = await loadGltf(this.device, "/models/test_world.glb");
        this.red = new UnshadedOpaque(this.device, [1,0,0,1]);
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
        const nodesWithRenderables = nodes.filter(n=>n.renderable != null);
        nodesWithRenderables.forEach(n=>{
            n.renderable!.material = this.red!;
        })
    }

}