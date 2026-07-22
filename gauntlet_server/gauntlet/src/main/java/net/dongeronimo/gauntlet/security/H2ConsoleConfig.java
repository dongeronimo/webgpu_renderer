package net.dongeronimo.gauntlet.security;

import org.h2.server.web.JakartaWebServlet;
import org.springframework.boot.web.servlet.ServletRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * O Boot 4 removeu o H2ConsoleAutoConfiguration que existia até o 3.x (a
 * propriedade spring.h2.console.enabled não faz mais nada sozinha) - o
 * servlet do H2 continua existindo no jar dele, só que agora ninguém mais
 * registra ele automaticamente. Isto substitui o que o Boot fazia: registra
 * na mesma rota de sempre. JakartaWebServlet (não o WebServlet "clássico",
 * que implementa javax.servlet.http.HttpServlet e nem compila aqui) é a
 * variante do H2 pro jakarta.servlet que este projeto usa (Tomcat 11/Boot 4).
 * SecurityConfig.filterChain é quem libera o /h2-console/** do login (senão
 * cai no .anyRequest().authenticated()).
 */
@Configuration
public class H2ConsoleConfig {
    @Bean
    ServletRegistrationBean<JakartaWebServlet> h2ConsoleServlet() {
        return new ServletRegistrationBean<>(new JakartaWebServlet(), "/h2-console/*");
    }
}
