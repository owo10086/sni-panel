# SNI 批量导入的本轮样本

起点为 a6f0c0f（v3.3.5 发布后的记录提交）。样本只有虚构用户、虚构 Agent 密钥、文档地址和 example.test 域名，不含生产数据。

`seed-0.db` 是空组，`seed-56.db` 有 56 条已有主规则及 168 个副本。三个入口在线，Agent 3.3.0；18443 业务端口，目标为 203.0.113.10。已有规则没有收到真实 Agent 的运行确认。明确传入零限速、零流量限额、outbound 和空到期时间，保留管理员托管含义。每轮重新固定在线时间并复制相同数据库。

样本 SHA256 在 manifest.json，数据库在 samples.tar.gz 内。解压后复核命令：

```bash
tar -xzf .scratch/2026-10-15_服务端批量导入/证据/测速样本/samples.tar.gz -C .scratch/2026-10-15_服务端批量导入/证据/测速样本
node scripts/benchmark-sni-import.mjs --samples .scratch/2026-10-15_服务端批量导入/证据/测速样本 --output /tmp/forwardx-batch-result.json --batch
```

不传 --batch 使用旧网页逐条预检加创建的方式（六条并发）；传入 --batch 使用一次完整批量创建。两种计时都结束于全部保存结果可用，准备和结果核对不计时，每个场景至少三轮，每批最多等 600 秒。通知接收器立即消费事件；本记录不包含网页刷新、真实 DNS、网络背压和生产主机生效。

使用已保存样本不要传 --prepare。修改前数字取自实施前的原版代码；在新版移除 --batch 只能对比调用方式，不能冒充原版版本基线。
