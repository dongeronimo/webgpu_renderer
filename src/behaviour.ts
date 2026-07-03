  //Sem este import, "Node" abaixo resolveria pro Node do DOM (lib.dom)!
  import type { Node } from "./node";

  export abstract class Behaviour {
      node!: Node; //preenchido ao anexar
      abstract update(deltaTime: number): void;
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