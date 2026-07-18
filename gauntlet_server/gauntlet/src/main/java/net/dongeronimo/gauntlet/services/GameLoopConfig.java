package net.dongeronimo.gauntlet.services;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class GameLoopConfig {
    /**
     * O executor COMPARTILHADO de todas as instâncias (pool pequeno de
     * propósito: tick é curto, N instâncias dividem 2 threads). A garantia que
     * segura o modelo: scheduleAtFixedRate NUNCA roda a mesma task em paralelo
     * consigo mesma (tick estourou 50 ms → o próximo espera) e há
     * happens-before entre execuções consecutivas — "um escritor lógico por
     * instância" sobrevive mesmo com a thread física variando entre ticks.
     */
    @Bean(destroyMethod = "shutdownNow")
    ScheduledExecutorService gameLoopExecutor() {
        AtomicInteger threadNumber = new AtomicInteger(1);
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(2, runnable -> {
            Thread thread = new Thread(runnable, "game-loop-" + threadNumber.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        });
        //tick cancelado sai da fila na hora, em vez de esperar o horário dele pra ser descartado
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }
}
