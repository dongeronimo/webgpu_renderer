//Captura e desenho do traço do lasso. Canvas 2D do DOM, não render target de
//GPU: é overlay de UI, não parte da imagem do volume — não precisa do
//framebuffer escalado, não entra no custo do raymarch e some do frame sem
//nenhum pass a mais.
//
//COMO A CÂMERA FICA CONGELADA: este overlay é renderizado logo DEPOIS do
//OrbitControls no App, e os dois são inset:0 no mesmo container. Sem z-index
//nenhum, quem vem depois pinta em cima — então o hit test entrega TODO evento
//de ponteiro aqui e nada chega na camada de órbita. A ordem no App é
//load-bearing: mover este componente pra depois dos painéis quebraria os
//painéis, e pra antes do OrbitControls devolveria a órbita pro usuário no meio
//do traço. Congelar o zoom junto é de propósito, não descuido: o polígono é
//capturado sob UMA viewProj, e mexer na câmera no meio do traço misturaria
//pontos de câmeras diferentes num polígono só.
//
//Os pontos são guardados em NDC (e não em pixels): é a mesma coordenada que o
//shader vai usar, e imuniza o traço contra o framebufferScale e contra resize
//da janela — redimensionar mantém o laço na mesma posição sobre o volume. O
//desenho converte NDC→CSS px na hora de pintar.
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";

type NdcPoint = { x: number; y: number };

//Distância mínima (em px de tela) entre pontos guardados. Sem isso um traço
//lento vira centenas de pontos colados, que não acrescentam forma nenhuma e
//custam caro no teste do shader depois.
const MIN_STEP_PX = 2;
//Menos que isso não é polígono — é clique. Um clique sem arrasto limpa em vez
//de virar um "lasso" degenerado de 2 pontos.
const MIN_POINTS = 3;

//Paleta: a mesma dos componentes (#7ab8ff). O traço é desenhado DUAS vezes,
//escuro e grosso por baixo, claro e fino por cima — é o que mantém a linha
//legível tanto sobre osso branco quanto sobre o fundo preto.
const HALO = "rgba(0, 0, 0, 0.55)";
const INK = "#7ab8ff";
const FILL = "rgba(122, 184, 255, 0.15)";

export function LassoCaptureOverlay() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    //Tudo em ref, nada em state: um traço à mão livre dispara pointermove a
    //~120Hz, e re-renderizar o React a cada ponto seria absurdo. O canvas é
    //pintado imperativamente pelo próprio handler.
    const points = useRef<NdcPoint[]>([]);
    //traço FECHADO (soltou o botão com pontos suficientes) vs. em andamento
    const closed = useRef(false);
    const stroke = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
    //rect do overlay, cacheado: o pointermove precisa dele pra converter pra
    //NDC, e ler getBoundingClientRect a cada evento é trabalho à toa.
    const rect = useRef<DOMRect | null>(null);

    function ndcToCss(p: NdcPoint, r: DOMRect): [number, number] {
        return [(p.x + 1) * 0.5 * r.width, (1 - p.y) * 0.5 * r.height];
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
        const pts = points.current;
        if (pts.length < 2) {
            return;
        }

        ctx.beginPath();
        const [x0, y0] = ndcToCss(pts[0], r);
        ctx.moveTo(x0, y0);
        for (let i = 1; i < pts.length; i++) {
            const [x, y] = ndcToCss(pts[i], r);
            ctx.lineTo(x, y);
        }

        //Preenchimento só no traço fechado — é a prévia do que vai sumir.
        //Regra NONZERO (o default do canvas), e não even-odd: lasso à mão livre
        //se auto-intersecta o tempo todo, e o nonzero é o que casa com "tudo que
        //eu cerquei". Quando o teste entrar no shader, tem que ser a MESMA regra
        //— senão a prévia mente sobre o corte.
        if (closed.current) {
            ctx.closePath();
            ctx.fillStyle = FILL;
            ctx.fill();
        }

        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.setLineDash([]);
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = HALO;
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = INK;
        ctx.stroke();

        //Enquanto desenha, a corda tracejada do último ponto até o primeiro
        //mostra por onde o polígono VAI fechar quando soltar o botão.
        if (!closed.current) {
            const [xn, yn] = ndcToCss(pts[pts.length - 1], r);
            ctx.beginPath();
            ctx.moveTo(xn, yn);
            ctx.lineTo(x0, y0);
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = HALO;
            ctx.stroke();
            ctx.lineWidth = 1;
            ctx.strokeStyle = INK;
            ctx.stroke();
            ctx.setLineDash([]);
        }
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

    function clearLasso() {
        points.current = [];
        closed.current = false;
        stroke.current = null;
        draw();
    }

    function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
        //RMB CANCELA — tanto o traço em andamento quanto o já fechado. Sai
        //antes de qualquer coisa pra o botão direito nunca começar traço.
        if (e.button === 2) {
            clearLasso();
            return;
        }
        //só LMB desenha; miolo/laterais não fazem nada
        if (e.button !== 0) {
            return;
        }
        //rect novo a cada traço: barato (1x por gesto) e cobre o caso de o
        //layout ter mudado sem o observer ter corrido ainda
        const r = e.currentTarget.getBoundingClientRect();
        rect.current = r;
        //traço novo substitui o anterior — um lasso por vez nesta etapa
        points.current = [{
            x: ((e.clientX - r.left) / r.width) * 2 - 1,
            y: 1 - ((e.clientY - r.top) / r.height) * 2,
        }];
        closed.current = false;
        stroke.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
        //captura: o move continua chegando mesmo se o ponteiro sair do overlay
        //(mesmo idioma do OrbitControls e do FloatingPanel)
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
        points.current.push({
            x: ((e.clientX - r.left) / r.width) * 2 - 1,
            y: 1 - ((e.clientY - r.top) / r.height) * 2,
        });
        draw();
    }

    function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
        const s = stroke.current;
        if (!s || e.pointerId !== s.pointerId) {
            return;
        }
        stroke.current = null;
        //clique sem arrasto não é lasso: limpa em vez de deixar um polígono
        //degenerado na tela
        if (points.current.length < MIN_POINTS) {
            clearLasso();
            return;
        }
        //fecha implicitamente (último→primeiro), como todo lasso: o usuário não
        //precisa acertar o ponto de partida
        closed.current = true;
        draw();
    }

    function onPointerCancel(e: ReactPointerEvent<HTMLCanvasElement>) {
        if (stroke.current?.pointerId === e.pointerId) {
            clearLasso();
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
