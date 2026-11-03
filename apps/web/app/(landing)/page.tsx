import { redirect } from "next/navigation";

// 本机版本的首页直接进入工作区，不展示官网或账号登录入口。
export default function LocalAppEntry() {
  redirect("/login");
}
