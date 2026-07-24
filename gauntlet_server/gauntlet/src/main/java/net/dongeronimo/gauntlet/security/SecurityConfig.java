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
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import jakarta.servlet.http.HttpServletResponse;
import java.util.List;

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
              //CORS: a página (gauntlet.dongeronimo.net, no CloudFront) fala com o
              //backend em api.dongeronimo.net — cross-origin, mas same-site. O bean
              //corsConfigurationSource libera os subdomínios do dongeronimo.net +
              //localhost COM credenciais (o cookie de sessão precisa viajar).
              .cors(Customizer.withDefaults())
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
              //POST /login processa; em vez de REDIRECIONAR (que quebrava o
              //cross-origin e dependia de o '/' resolver num 200 — via CloudFront
              //caía no index.html do S3), devolve STATUS — estilo SPA. O client
              //(GauntletLoginPanel) já checa resp.ok. Mata junto a treta do
              //redirect http:// (não há mais redirect nenhum pra montar).
              .formLogin(form -> form
                  .successHandler((req, res, auth) -> res.setStatus(HttpServletResponse.SC_OK))
                  .failureHandler((req, res, ex) -> res.setStatus(HttpServletResponse.SC_UNAUTHORIZED)))
              // Endpoint POST /logout e GET /logout
              .logout(Customizer.withDefaults())
              //o console do H2 se desenha em <frame>; o X-Frame-Options DENY
              //padrão do Spring Security bloquearia isso.
              .headers(headers -> headers.frameOptions(frame -> frame.sameOrigin()));
          return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        //Patterns pra poder usar curinga COM allowCredentials(true)
        //(setAllowedOrigins("*") é proibido junto de credenciais). Prod =
        //qualquer subdomínio do dongeronimo.net; dev = qualquer porta do localhost.
        CorsConfiguration cfg = new CorsConfiguration();
        cfg.setAllowedOriginPatterns(List.of("https://*.dongeronimo.net", "http://localhost:*"));
        cfg.setAllowedMethods(List.of("GET", "POST", "OPTIONS"));
        cfg.setAllowedHeaders(List.of("*"));
        cfg.setAllowCredentials(true);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cfg);
        return source;
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
