//Espelho de JoinRequest.java. character é a escolha feita no modal pós-login
//(ver GauntletCharacterSelectPanel.tsx / redux gauntlet.character) — mesma
//string usada como nome do prefab (gauntletWorld.ts).
export function joinRequest(character: string) {
    return {
        "operation": "join",
        character,
    };
}
