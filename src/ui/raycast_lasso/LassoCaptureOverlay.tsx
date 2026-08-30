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
//
//O QUE FICA DESENHADO: só os lassos fechados NESTA sessão de ferramenta. Eles
//continuam no redux depois que o usuário solta o lasso, mas parar de desenhá-los
//é o certo — o contorno em NDC só corresponde ao que está na tela enquanto a
//câmera for a que o capturou. Soltar a ferramenta, orbitar e rearmar zera o
//desenho; quem passa a mostrar os recortes antigos é o próprio volume, quando o
//teste entrar no shader.
import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import type { Mat4 } from "wgpu-matrix";
import { useDispatch } from "react-redux";
import { lassoAdded } from "../../redux/actions";
import type { AppDispatch } from "../../redux/store";
import type { RaycastLassoWorld } from "../../raycastLasso/raycastLassoWorld";
import { nextLassoId } from "../../raycastLasso/lassoData";

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

export function LassoCaptureOverlay({ world }: { world: RaycastLassoWorld }) {
    const dispatch = useDispatch<AppDispatch>();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    //Tudo em ref, nada em state: um traço à mão livre dispara pointermove a
    //~120Hz, e re-renderizar o React a cada ponto seria absurdo. O canvas é
    //pintado imperativamente pelo próprio handler.
    //
    //current = o traço em andamento; committed = os que já fecharam nesta
    //sessão, guardados aqui só pra DESENHAR (a fonte de verdade deles é o
    //redux, e o id é o que liga um ao outro).
    const current = useRef<NdcPoint[]>([]);
    const committed = useRef<{ id: number; pts: NdcPoint[] }[]>([]);
    const stroke = useRef<{
        pointerId: number;
        lastX: number;
        lastY: number;
        //A câmera CONGELADA deste traço, capturada no pointerdown. É por isso
        //que ela é lida aqui e não no pointerup: no down é que o traço nasce, e
        //daí em diante a câmera não pode mais mudar (este overlay come os
        //eventos que a moveriam).
        clipFromLocal: Mat4;
    } | null>(null);
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
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        //O contexto é o mesmo objeto entre draws: começar zerando o dash evita
        //que o tracejado da corda vaze pro desenho seguinte.
        ctx.setLineDash([]);

        //Os fechados: contorno + interior translúcido (a prévia do que sumiria).
        //Regra NONZERO (o default do canvas), e não even-odd: lasso à mão livre
        //se auto-intersecta o tempo todo, e o nonzero é o que casa com "tudo que
        //eu cerquei". Quando o teste entrar no shader, tem que ser a MESMA regra
        //— senão a prévia mente sobre o corte.
        for (const lasso of committed.current) {
            tracePath(ctx, lasso.pts, r);
            ctx.closePath();
            ctx.fillStyle = FILL;
            ctx.fill();
            strokeTwice(ctx, 3.5, 1.5);
        }

        //O traço em andamento: aberto, com a corda tracejada do último ponto até
        //o primeiro mostrando por onde o polígono VAI fechar.
        const pts = current.current;
        if (pts.length < 2) {
            return;
        }
        tracePath(ctx, pts, r);
        ctx.setLineDash([]);
        strokeTwice(ctx, 3.5, 1.5);

        const [x0, y0] = ndcToCss(pts[0], r);
        const [xn, yn] = ndcToCss(pts[pts.length - 1], r);
        ctx.beginPath();
        ctx.moveTo(xn, yn);
        ctx.lineTo(x0, y0);
        ctx.setLineDash([4, 4]);
        strokeTwice(ctx, 3.5, 1);
        ctx.setLineDash([]);
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

    //Halo escuro por baixo, tinta clara por cima — o que dá contraste sobre
    //qualquer coisa que o volume esteja mostrando ali atrás.
    function strokeTwice(ctx: CanvasRenderingContext2D, halo: number, ink: number) {
        ctx.lineWidth = halo;
        ctx.strokeStyle = HALO;
        ctx.stroke();
        ctx.lineWidth = ink;
        ctx.strokeStyle = INK;
        ctx.stroke();
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

    function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
        //RMB CANCELA O TRAÇO EM ANDAMENTO — e só isso. Sem traço na mão ele não
        //faz nada: apagar um lasso JÁ FECHADO é undo, e undo vai ser botão
        //próprio na UI. Escondido num botão do mouse ele seria destrutivo e
        //invisível — clique errado apaga trabalho sem nada na tela dizendo que
        //dá pra apagar.
        if (e.button === 2) {
            if (stroke.current) {
                stroke.current = null;
                current.current = [];
                draw();
            }
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
        current.current = [{
            x: ((e.clientX - r.left) / r.width) * 2 - 1,
            y: 1 - ((e.clientY - r.top) / r.height) * 2,
        }];
        stroke.current = {
            pointerId: e.pointerId,
            lastX: e.clientX,
            lastY: e.clientY,
            clipFromLocal: world.captureClipFromLocal(),
        };
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
        current.current.push({
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
        const pts = current.current;
        current.current = [];
        //clique sem arrasto não é lasso: some em vez de virar um polígono
        //degenerado
        if (pts.length < MIN_POINTS) {
            draw();
            return;
        }
        //Fecha implicitamente (último→primeiro), como todo lasso: o usuário não
        //precisa acertar o ponto de partida — e por isso o primeiro ponto NÃO é
        //repetido no fim do array.
        const id = nextLassoId();
        committed.current.push({ id, pts });
        //Achata pro formato que o shader vai consumir: x,y intercalados.
        const points = new Float32Array(pts.length * 2);
        for (let i = 0; i < pts.length; i++) {
            points[i * 2] = pts[i].x;
            points[i * 2 + 1] = pts[i].y;
        }
        dispatch(lassoAdded({ id, points, clipFromLocal: s.clipFromLocal }));
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
