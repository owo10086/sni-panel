# SNI 导入测速样本

仅包含虚构测试用户、测试 Agent 密钥、文档专用地址和 example.test 域名，没有生产数据。

旧版业务代码（192e994）生成两份临时 SQLite 起始样本，前后每轮均复制相同文件，SHA256 见 manifest.json。三台入口在线，Agent 3.3.0；业务端口 18443，目标 203.0.113.10。seed-0.db 没有规则；seed-56.db 有 56 条 seed 域名及 168 个副本，尚未得到真实 Agent 的运行确认。每轮启动重新设置入口在线时间。

数据库在归档中保存，以便其他机器复核。先在本目录解压，然后从仓库根目录运行：

```bash
tar -xzf .scratch/2026-10-14_SNI批量导入提速/证据/测速样本/samples.tar.gz -C .scratch/2026-10-14_SNI批量导入提速/证据/测速样本
node scripts/benchmark-sni-import.mjs --samples .scratch/2026-10-14_SNI批量导入提速/证据/测速样本 --output /tmp/sni-import-recheck.json
```

使用已保存样本时不要传 --prepare。工具会检查样本哈希，恢复样本后再执行逐条域名检查和创建，最多同时处理 6 条，每个场景三轮；每批等待上限 600 秒。消息接收器立即消费通知，不模拟网络背压或生产通知积压。没有真实 DNS 或真实主机流量，因此只能比较同等条件下的后台等待时间。
