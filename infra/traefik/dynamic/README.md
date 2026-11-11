# Traefik 动态配置目录（file provider 监听此处）

当前为空——应用路由全部由中台在发布容器时通过 docker label 动态创建
（Traefik 的 docker provider 实时感知），无需在此手写任何应用路由。

预留能力：如需与中台无关的静态路由（如运维面板、监控），把 .yml 放进本目录，
Traefik 会 watch 热加载。注意安全默认 exposedByDefault=false 只约束 docker provider，
file provider 的路由会立即生效，放置前先确认暴露面。
