package net.dongeronimo.gauntlet.security;
import org.springframework.security.config.Customizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;

import net.dongeronimo.gauntlet.persistence.PlayerPersistence;

@Configuration
@EnableWebSecurity
public class SecurityConfig {
    private PlayerPersistence playerService;
    public SecurityConfig(PlayerPersistence playerService) {
        this.playerService = playerService;
    }
    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
              //não exigir o token no x-csrf-token pq por hora o unico endpoint mutável é 
              //POST /login, websocket não é coberto pelo csrf e o proxy do vite fará tudo
              //ficar same origin. Quando a gente tiver endpoints REST mutáveis autenticados
              //por cookie ai isso precisa ser ligado.
              .csrf(csrf -> csrf.disable())
              // Somente player pode entrar. resto é barrado.
              .authorizeHttpRequests(auth -> auth
                  //console de dev pra olhar o H2 na mão - sem isto cai no
                  //.anyRequest().authenticated() de baixo. PathPatternRequestMatcher
                  //explícito (não o overload de String) porque o console do H2
                  //é um Servlet cru, não um @Controller do Spring MVC - o
                  //matcher ciente de MVC que o overload de String usa por
                  //padrão não reconhece essa rota e cai no fallback autenticado
                  //(era por isso que /h2-console redirecionava pro /login).
                  .requestMatchers(PathPatternRequestMatcher.pathPattern("/h2-console/**")).permitAll()
                  .requestMatchers("/ws/**").hasRole("PLAYER")
                  //GET dos parâmetros de movimento (ver PlayerControllerSettingsController) -
                  //@RestController de verdade (Spring MVC), então o matcher por
                  //String funciona normal aqui (diferente do /h2-console, que é
                  //um Servlet cru).
                  .requestMatchers("/api/player-controller-settings/*").hasRole("PLAYER")
                  .anyRequest().authenticated())
              //default cria endpoints GET /login e POST /login
              .formLogin(Customizer.withDefaults())
              // Endpoint POST /logout e GET /logout
              .logout(Customizer.withDefaults())
              //o console do H2 se desenha em <frame>; o X-Frame-Options DENY
              //padrão do Spring Security bloquearia isso.
              .headers(headers -> headers.frameOptions(frame -> frame.sameOrigin()));
          return http.build();
    }

    @Bean
    public UserDetailsService users() {
        return username -> playerService.findByName(username)
        .map(p -> User.withUsername(p.getName())
        .password(p.getPassword())
        .roles("PLAYER")
        .build())
        .orElseThrow( () -> new UsernameNotFoundException(username));        
    }
}
