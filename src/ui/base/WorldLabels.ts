//Rótulo legível por mundo. Record<WorldName, string> de propósito: quando
//nascer um mundo novo no union, este objeto quebra em compile time até

import { WorldName } from "../../redux/actions";

//ganhar o rótulo dele.
export const worldLabels: Record<WorldName, string> = {
    solarSystem: "Sistema Solar",
    textureStackVolumeRenderSynthetic: "Texture-based slicing (sintético)",
    textureStackVolumeRenderCT: "Texture-based slicing (CT)",
    StarshipDemo : "Starship (demo)",
    raycast: "Raycaster",
};