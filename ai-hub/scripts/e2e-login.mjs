/** e2e 脚本共用的门户登录助手。
 *
 * dev Provider：走 /__hub__/auth/dev-login 自建测试用户。
 * 其他 Provider（生产为飞书 OAuth，dev-login 已关闭）：回退到门户已有用户
 * ——优先按姓名匹配（seed 数据里的方科/小李），否则取最近登录的用户，
 * 用其 Bearer token 访问 /__hub__/me 验证身份。
 *
 * 返回 { user, cookie }；cookie 仅在 dev 模式有值（回退模式用 Bearer token）。
 */
import { load } from "../src/store.js";

export async function hubLogin(name, department) {
  const HUB = `http://localhost:${process.env.HUB_PORT || 8080}`;
  const res = await fetch(
    `${HUB}/__hub__/auth/dev-login?name=${encodeURIComponent(name)}&department=${encodeURIComponent(department || "")}`,
    { redirect: "manual" },
  );
  if (res.status !== 400) {
    const setCookie = res.headers.getSetCookie()[0];
    if (!setCookie) throw new Error(`dev-login 未返回 Set-Cookie（HTTP ${res.status}）`);
    const cookie = setCookie.split(";")[0];
    const me = await fetch(`${HUB}/__hub__/me`, { headers: { cookie } });
    const data = await me.json();
    return { user: data.user, cookie };
  }
  // 非 dev Provider：dev-login 不可用，回退到门户已有账号
  const store = load();
  const user = store.users.find((u) => u.name === name) || store.users[store.users.length - 1];
  if (!user) throw new Error("当前身份 Provider 不是 dev，且门户尚无已有用户——请先在网页完成一次登录");
  const me = await fetch(`${HUB}/__hub__/me`, { headers: { Authorization: `Bearer ${user.token}` } });
  if (!me.ok) throw new Error(`回退登录失败: HTTP ${me.status}`);
  const data = await me.json();
  if (data.user.name !== name) {
    console.log(`  （Provider 非 dev：${name} 回退为已有用户 ${data.user.name}）`);
  }
  return { user: data.user, cookie: null };
}
