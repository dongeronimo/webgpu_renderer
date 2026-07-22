import {Node} from "./node"
export default interface PrefabFabricator {
    fabricate(
        position:[number, number, number],
        prefabName: string,
        parent:Node
    ):Node;
}