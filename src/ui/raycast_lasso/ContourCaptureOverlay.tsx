//Captura e desenho de um CONTORNO à mão livre. Canvas 2D do DOM, não render
//target de GPU: é overlay de UI, não parte da imagem do volume — não precisa do
//framebuffer escalado, não entra no custo do raymarch e some do frame sem
//nenhum pass a mais.
//
//Genérico entre as ferramentas de propósito, ao contrário do resto: o dado
//(LassoData × ScalpelData), o recurso de GPU e o caminho no shader são
//separados porque significam coisas diferentes, mas o GESTO é literalmente o
//mesmo — arrastar com o esquerdo desenha, direito cancela, solta e fecha. O que
//muda é a cor e pra onde vai o resultado, e isso entra por prop.
//
//COMO A CÂMERA FICA CONGELADA: este overlay é renderizado logo DEPOIS do
//OrbitControls no App, e os dois são inset:0 no mesmo container. Sem z-index
//nenhum, quem vem depois pinta em cima — então o hit test entrega TODO evento
//de ponteiro aqui e nada chega na camada de órbita. A ordem no App é
//load-bearing: mover este componente pra depois dos painéis quebraria os
//painéis, e pra antes do OrbitControls devolveria a órbita pro usuário no meio
//do traço. Congelar o zoom junto é de propósito: o contorno é capturado sob UMA
//viewProj, e mexer na câmera no meio do traço misturaria pontos de câmeras
//diferentes num polígono só.
//
//Os pontos são guardados em NDC (e não em pixels): é a mesma coordenada que o
//shader vai usar, e imuniza o traço contra o framebufferScale e contra resize
//da janela. O desenho converte NDC→CSS px na hora de pintar.
//
//O QUE FICA DESENHADO: só os contornos fechados NESTA sessão de ferramenta.
//Eles continuam no redux depois, mas parar de desenhá-los é o certo — o
//contorno em NDC só corresponde ao que está na tela enquanto a câmera for a que
//o capturou. Soltar a ferramenta, orbitar e rearmar zera o desenho; quem passa
//a mostrar os cortes antigos é o próprio volume.
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import type { Mat4 } from "wgpu-matrix";
import type { RaycastLassoWorld } from "../../raycastLasso/raycastLassoWorld";

type NdcPoint = { x: number; y: number };

//Distância mínima (em px de tela) entre pontos guardados. Sem isso um traço
//lento vira centenas de pontos colados, que não acrescentam forma nenhuma e
//custam caro na rasterização depois.
const MIN_STEP_PX = 2;
//Menos que isso não é polígono — é clique.
const MIN_POINTS = 3;

//Halo escuro por baixo da cor da ferramenta: é o que mantém a linha legível
//tanto sobre osso branco quanto sobre o fundo preto.
const HALO = "rgba(0, 0, 0, 0.55)";

export type ContourCaptureOverlayProps = {
    world: RaycastLassoWorld;
    /** Cor do traço — a identidade visual da ferramenta. */
    ink: string;
    /** Preenchimento dos contornos já fechados (a prévia do que vai sumir). */
    fill: string;
    /**
     * Alt na hora de começar o traço INVERTE a operação da ferramenta?
     *
     * O overlay não sabe o que "invertido" significa — só que, quando é o caso,
     * o preenchimento vai pra FORA do contorno (porque o que some é o resto) e
     * o flag viaja no onCommit. Quem dá sentido a ele é o consumidor.
     *
     * Lido no pointerdown e congelado ali, como a câmera: o traço inteiro é de
     * um tipo só, e apertar Alt no meio não muda o que já começou. De quebra,
     * ler só o altKey do evento evita o keydown de Alt solto, que no Windows
     * rouba o foco pro menu do browser.
     */
    altInverts?: boolean;
    /**
     * Chamado quando um contorno fecha. Recebe os pontos já achatados
     * (x,y intercalados, NDC, aberto), a câmera CONGELADA no início do traço, e
     * se o traço saiu invertido (só possível com altInverts).
     * Quem monta o dado da ferramenta e despacha é o consumidor.
     */
    onCommit: (points: Float32Array, clipFromLocal: Mat4, inverted: boolean) => void;
};

export function ContourCaptureOverlay({ world, ink, fill, altInverts = false, onCommit }: ContourCaptureOverlayProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    //Tudo em ref, nada em state: um traço à mão livre dispara pointermove a
    //~120Hz, e re-renderizar o React a cada ponto seria absurdo. O canvas é
    //pintado imperativamente pelo próprio handler.
    const current = useRef<NdcPoint[]>([]);
    //inverted junto dos pontos: dois traços da mesma sessão podem ser de tipos
    //diferentes, e o desenho de cada um depende do tipo DELE.
    const committed = useRef<{ pts: NdcPoint[]; inverted: boolean }[]>([]);
    const stroke = useRef<{
        pointerId: number;
        lastX: number;
        lastY: number;
        //A câmera CONGELADA deste traço, capturada no pointerdown. É por isso
        //que ela é lida aqui e não no pointerup: no down é que o traço nasce, e
        //daí em diante a câmera não pode mais mudar (este overlay come os
        //eventos que a moveriam).
        clipFromLocal: Mat4;
        //Alt estava apertado quando o traço começou?
        inverted: boolean;
    } | null>(null);
    const rect = useRef<DOMRect | null>(null);
    //ink/fill num ref pra o draw() não depender do ciclo de render do React.
    const colors = useRef({ ink, fill });
    colors.current = { ink, fill };

    function ndcToCss(p: NdcPoint, r: DOMRect): [number, number] {
        return [(p.x + 1) * 0.5 * r.width, (1 - p.y) * 0.5 * r.height];
    }

    /**
     * Pinta o que a operação AFETA: o miolo do contorno no caso normal, tudo
     * MENOS o miolo quando invertido.
     *
     * O invertido sai de graça da regra even-odd: um retângulo da tela inteira
     * mais o contorno dentro dele deixa o miolo com winding par, ou seja, de
     * fora. Nada de recortar na mão.
     *
     * O caso normal usa NONZERO (o default), que é a MESMA regra da
     * rasterização em contourMask.ts — traço à mão livre se auto-intersecta e
     * as duas regras têm que concordar, senão a prévia mente sobre o corte.
     */
    function fillRegion(ctx: CanvasRenderingContext2D, r: DOMRect, inverted: boolean) {
        if (!inverted) {
            ctx.fill();
            return;
        }
        ctx.rect(0, 0, r.width, r.height);
        ctx.fill("evenodd");
    }

    function tracePath(ctx: CanvasRenderingContext2D, pts: NdcPoint[], r: DOMRect) {
        ctx.beginPath();
        const [x0, y0] = ndcToCss(pts[0], r);
        ctx.moveTo(x0, y0);
        for (let i = 1; i < pts.length; i++) {
            const [x, y] = ndcToCss(pts[i], r);
            ctx.lineTo(x, y);
        }
    }

    function strokeTwice(ctx: CanvasRenderingContext2D, halo: number, inkWidth: number) {
        ctx.lineWidth = halo;
        ctx.strokeStyle = HALO;
        ctx.stroke();
        ctx.lineWidth = inkWidth;
        ctx.strokeStyle = colors.current.ink;
        ctx.stroke();
    }

    function draw() {
        const canvas = canvasRef.current;
        const r = rect.current;
        if (!canvas || !r) {
            return;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            return;
        }
        //limpa em CSS px: o setTransform do resize já pôs o dpr na matriz
        ctx.clearRect(0, 0, r.width, r.height);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        //O contexto é o mesmo objeto entre draws: começar zerando o dash evita
        //que o tracejado da corda vaze pro desenho seguinte.
        ctx.setLineDash([]);

        //Os fechados: contorno + interior translúcido. Regra NONZERO (o default
        //do canvas), a mesma da rasterização em contourMask.ts — se as duas
        //divergirem, a prévia mente sobre o corte.
        for (const lasso of committed.current) {
            tracePath(ctx, lasso.pts, r);
            ctx.closePath();
            ctx.fillStyle = colors.current.fill;
            fillRegion(ctx, r, lasso.inverted);
            strokeTwice(ctx, 3.5, 1.5);
        }

        const pts = current.current;
        if (pts.length < 2) {
            return;
        }
        tracePath(ctx, pts, r);
        //Prévia já durante o traço quando ele é invertido: sem isso o usuário
        //só descobriria que sombreou o mundo inteiro depois de soltar.
        if (stroke.current?.inverted) {
            ctx.fillStyle = colors.current.fill;
            fillRegion(ctx, r, true);
            tracePath(ctx, pts, r); //o fill consumiu o path
        }
        ctx.setLineDash([]);
        strokeTwice(ctx, 3.5, 1.5);

        //A corda tracejada do último ponto até o primeiro mostra por onde o
        //polígono VAI fechar quando soltar o botão.
        const [x0, y0] = ndcToCss(pts[0], r);
        const [xn, yn] = ndcToCss(pts[pts.length - 1], r);
        ctx.beginPath();
        ctx.moveTo(xn, yn);
        ctx.lineTo(x0, y0);
        ctx.setLineDash([4, 4]);
        strokeTwice(ctx, 3.5, 1);
        ctx.setLineDash([]);
    }

    //Tamanho do backing store = CSS × dpr, senão a linha sai borrada em tela
    //hidpi. ResizeObserver (e não window.resize) pega qualquer mudança de
    //layout, não só a da janela.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        function resize() {
            const r = canvas!.getBoundingClientRect();
            rect.current = r;
            const dpr = window.devicePixelRatio || 1;
            canvas!.width = Math.max(1, Math.round(r.width * dpr));
            canvas!.height = Math.max(1, Math.round(r.height * dpr));
            //setTransform (e não scale) porque mexer no width/height do canvas
            //já zera a matriz — scale acumularia a cada resize.
            canvas!.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
            draw();
        }
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        return () => observer.disconnect();
    }, []);

    function toNdc(clientX: number, clientY: number, r: DOMRect): NdcPoint {
        return {
            x: ((clientX - r.left) / r.width) * 2 - 1,
            y: 1 - ((clientY - r.top) / r.height) * 2,
        };
    }

    function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
        //RMB CANCELA O TRAÇO EM ANDAMENTO — e só isso. Sem traço na mão ele não
        //faz nada: apagar um contorno JÁ FECHADO é undo, e undo vai ser botão
        //próprio na UI. Escondido num botão do mouse ele seria destrutivo e
        //invisível.
        if (e.button === 2) {
            if (stroke.current) {
                stroke.current = null;
                current.current = [];
                draw();
            }
            return;
        }
        if (e.button !== 0) {
            return;
        }
        const r = e.currentTarget.getBoundingClientRect();
        rect.current = r;
        current.current = [toNdc(e.clientX, e.clientY, r)];
        stroke.current = {
            pointerId: e.pointerId,
            lastX: e.clientX,
            lastY: e.clientY,
            clipFromLocal: world.captureClipFromLocal(),
            inverted: altInverts && e.altKey,
        };
        //captura: o move continua chegando mesmo se o ponteiro sair do overlay
        e.currentTarget.setPointerCapture(e.pointerId);
        draw();
    }

    function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
        const s = stroke.current;
        const r = rect.current;
        if (!s || !r || e.pointerId !== s.pointerId) {
            return;
        }
        const dx = e.clientX - s.lastX;
        const dy = e.clientY - s.lastY;
        if (dx * dx + dy * dy < MIN_STEP_PX * MIN_STEP_PX) {
            return;
        }
        s.lastX = e.clientX;
        s.lastY = e.clientY;
        current.current.push(toNdc(e.clientX, e.clientY, r));
        draw();
    }

    function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
        const s = stroke.current;
        if (!s || e.pointerId !== s.pointerId) {
            return;
        }
        stroke.current = null;
        const pts = current.current;
        current.current = [];
        if (pts.length < MIN_POINTS) {
            draw();
            return;
        }
        committed.current.push({ pts, inverted: s.inverted });
        //Achata pro formato que a rasterização e o shader consomem. O primeiro
        //ponto NÃO é repetido no fim: o fechamento é implícito.
        const points = new Float32Array(pts.length * 2);
        for (let i = 0; i < pts.length; i++) {
            points[i * 2] = pts[i].x;
            points[i * 2 + 1] = pts[i].y;
        }
        onCommit(points, s.clipFromLocal, s.inverted);
        draw();
    }

    function onPointerCancel(e: ReactPointerEvent<HTMLCanvasElement>) {
        if (stroke.current?.pointerId === e.pointerId) {
            stroke.current = null;
            current.current = [];
            draw();
        }
    }

    //Sem isso o RMB abriria o menu do browser por cima do traço.
    function onContextMenu(e: ReactMouseEvent<HTMLCanvasElement>) {
        e.preventDefault();
    }

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                //#ui-root desliga o mouse; aqui religa, como o OrbitControls
                pointerEvents: "auto",
                touchAction: "none", //senão o browser rouba o gesto pra scroll
                cursor: "crosshair",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={onContextMenu}
        />
    );
}
