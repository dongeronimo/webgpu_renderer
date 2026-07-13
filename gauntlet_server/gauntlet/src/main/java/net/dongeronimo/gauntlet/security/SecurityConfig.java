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
                  .requestMatchers("/ws/**").hasRole("PLAYER")
                  .anyRequest().authenticated())       
              //default cria endpoints GET /login e POST /login    
              .formLogin(Customizer.withDefaults())  
              // Endpoint POST /logout e GET /logout
              .logout(Customizer.withDefaults());
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
