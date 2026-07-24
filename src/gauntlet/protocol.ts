//Versão do protocolo de rede. INCREMENTAR a cada mudança em qualquer mensagem.
//Espelho de Protocol.java (VERSION) — os dois sobem JUNTOS (deploy.py all).
//
//Toda mensagem carrega protocolVersion. O server ignora mensagem de versão
//abaixo da dele; o client EXPLODE se receber mensagem abaixo da dele (server
//velho = client à frente — falha alto em vez de agir com dado incompatível).
export const PROTOCOL_VERSION = 1;

/** Explode se a mensagem recebida vier de um protocolo mais VELHO que o
 *  esperado. Sem o campo (server pré-versionamento) conta como 0 → explode.
 *  Param unknown (não `{protocolVersion?}`): o campo é injetado no wire, não
 *  está nos tipos de mensagem — o cast lê ele sem o weak-type check do TS. */
export function assertProtocol(msg: unknown): void {
    const v = (msg as { protocolVersion?: number }).protocolVersion ?? 0;
    if (v < PROTOCOL_VERSION) {
        throw new Error(
            `Protocolo do server (${v}) abaixo do esperado (${PROTOCOL_VERSION}) — ` +
            `client à frente do server. Faltou deployar/reiniciar o server (deploy.py all).`);
    }
}
