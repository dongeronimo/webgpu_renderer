//Painel de login do mundo gauntlet. O POST /login mora AQUI temporariamente
//— no futuro haverá uma central pras comunicações HTTPS (login, matchmaking,
//etc.); por ora o form é o único cliente HTTP, então ele mesmo faz o fetch.
//Sucesso → dispatch de gauntletLoginSucceeded: a credencial vira o cookie de
//sessão e a GauntletNetworkBehaviour (lendo a flag no update dela) dispara
//signaling → join → /ws/game. A senha vive só no state local deste form.
import { useState } from "react";
import type { FormEvent } from "react";
import { useDispatch, useSelector } from "react-redux";
import { gauntletLoginSucceeded } from "../../redux/actions";
import type { RootState } from "../../redux/reducers";
import type { AppDispatch } from "../../redux/store";
import { Button } from "../generic/Button";
import { FloatingPanel } from "../generic/FloatingPanel";

export function GauntletLoginPanel() {
    const dispatch = useDispatch<AppDispatch>();
    const { username, loggedIn } = useSelector((state: RootState) => state.gauntlet);
    const [user, setUser] = useState("");
    const [password, setPassword] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(e: FormEvent) {
        //form de verdade (submit com Enter funciona), mas sem navegação
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
            const resp = await fetch("/login", {
                method: "POST",
                body: new URLSearchParams({ username: user, password }),
            });
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            dispatch(gauntletLoginSucceeded(user));
        } catch (err) {
            console.error("GauntletLoginPanel: login falhou", err);
            setError("Login falhou — confere usuário/senha (e se o server está de pé).");
        } finally {
            setPending(false);
        }
    }

    return (
        <FloatingPanel title="Gauntlet" width={240} height="auto" style={{ top: 8, left: 8 }}>
            {loggedIn ? (
                <div>Logado como <strong>{username}</strong>. Entrando na instância…</div>
            ) : (
                <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <input
                        placeholder="usuário"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                        disabled={pending}
                        autoComplete="username"
                    />
                    <input
                        placeholder="senha"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={pending}
                        autoComplete="current-password"
                    />
                    {/*type=submit de propósito: o Button genérico força "button"
                       por default e o Enter do form deixaria de funcionar*/}
                    <Button type="submit" disabled={pending || user === "" || password === ""}>
                        {pending ? "Entrando..." : "Entrar"}
                    </Button>
                    {error && <div style={{ color: "#ff6b6b" }}>{error}</div>}
                </form>
            )}
        </FloatingPanel>
    );
}
