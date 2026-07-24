  //Sem este import, "Node" abaixo resolveria pro Node do DOM (lib.dom)!
  //Import de VALOR (não type-only) porque o clone default usa `instanceof Node`.
  import { Node } from "./node";

  export abstract class Behaviour {
      node!: Node; //preenchido ao anexar
      abstract update(deltaTime: number): void;
      /**
       * Análogo do LateUpdate da Unity: roda DEPOIS de todos os update() do
       * frame, com as posições da árvore inteira já finalizadas. É onde uma
       * câmera que segue um alvo deve rodar — no update() ela pode ler a
       * posição do alvo de UM FRAME ATRÁS (a travessia é pré-ordem: um nó
       * visitado antes do alvo vê o valor velho dele), e isso vira tremor
       * dependente de frame rate (o offset carrega o deltaTime·v jittery).
       * No-op por default: quase toda behaviour só precisa do update().
       */
      lateUpdate(_deltaTime: number): void {}
      /**
       * True só se esta behaviour SOBRESCREVE lateUpdate (não o no-op da base).
       * O World coleta os nós com lateUpdate durante a passada de update e
       * revisita só esses depois — em vez de descer a árvore inteira 2x. A
       * comparação de referência de método pega override em qualquer nível da
       * cadeia de herança.
       */
      get overridesLateUpdate(): boolean {
          return this.lateUpdate !== Behaviour.prototype.lateUpdate;
      }
      private alreadyCalledStart:boolean = false;
      /**
       * Dispara start() uma única vez (idempotente via `alreadyCalledStart`).
       * É o portão único do start: tanto o clone de prefab (no instantiate)
       * quanto o World.update (no 1º frame) chamam por aqui, então start()
       * roda exatamente uma vez, independente de quem chegar primeiro.
       */
      callStartIfHaventYet(){
        if(!this.alreadyCalledStart){
            this.start();
            this.alreadyCalledStart = true;
        }
      }
      /**
       * Chamado UMA vez, antes do primeiro update, com a árvore montada e as
       * refs de nó já remapeadas. É o lugar pra resolver referências e alocar
       * estado por-instância — o análogo do Awake/Start da Unity. No-op por
       * default. Não chame direto: use callStartIfHaventYet() pra garantir a
       * chamada única.
       */
      start(): void {}

      /**
       * Libera estado por-instância desta behaviour (ex.: buffers de GPU que
       * ela mesma criou). Chamado pelo destroyInstance ao tirar a instância
       * de cena. No-op por default: a maioria das behaviours não tem estado
       * de GPU próprio.
       */
      dispose(): void {}

      /**
       * Clona esta behaviour para uma instância de prefab. `map` leva cada
       * Node do template ao seu clone — use-o pra remapear referências
       * cruzadas de nó (target, etc.) pro nó correspondente da CÓPIA.
       *
       * Default: reconstrói via ctor SEM argumentos e copia os campos
       * próprios, trocando os que forem Node pelo clone (ref a um nó FORA do
       * prefab fica como está). Sobrescreva quando a behaviour tiver ctor com
       * argumentos, estado não-clonável (handles de GPU), ou refs de nó
       * dentro de arrays/objetos, que a cópia rasa não alcança.
       */
      clone(map: Map<Node, Node>): Behaviour {
          const copy = new (this.constructor as new () => Behaviour)();
          const src = this as unknown as Record<string, unknown>;
          const dst = copy as unknown as Record<string, unknown>;
          for (const key of Object.keys(this)) {
              if (key === "node") continue; //religado pelo cloner
              const value = src[key];
              dst[key] = value instanceof Node ? (map.get(value) ?? value) : value;
          }
          return copy;
      }
  }

  type BehaviourCtor = new () => Behaviour;
  const registry = new Map<string, BehaviourCtor>();

  export function registerBehaviour(name: string, ctor: BehaviourCtor): void {
      registry.set(name, ctor);
  }

  export function createBehaviour(name: string): Behaviour {
      const ctor = registry.get(name);
      if (!ctor) throw new Error(`Behaviour desconhecido: "${name}"`);
      return new ctor();
  }