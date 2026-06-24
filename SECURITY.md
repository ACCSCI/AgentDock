# Security Policy

## 支持的版本

| 版本 | 支持状态 |
|------|---------|
| 最新(`master` 分支) | ✅ 积极维护 |
| 旧版本 | ❌ 不再提供安全更新 |

AgentDock 目前处于早期开发阶段(v0.1.x),我们**只为最新版本**提供安全更新。请始终使用最新代码。

## 报告安全漏洞

**请不要通过公开 GitHub Issues 报告安全漏洞。**

如果你发现了安全漏洞,请通过以下方式**私下**报告:

- 📧 **Email**:在 GitHub 个人资料中找到维护者的联系方式,或 [新建一个 GitHub Security Advisory](https://github.com/ACCSCI/AgentDock/security/advisories/new)
- 🔐 **GitHub Security Advisories**:https://github.com/ACCSCI/AgentDock/security/advisories/new(推荐)

请包含以下信息:

- 漏洞类型(如 XSS、命令注入、路径穿越、权限提升等)
- 受影响的文件 / 模块
- 复现步骤(尽量详细)
- 概念验证(PoC)代码或截图
- 潜在影响评估
- 你的 GitHub 用户名(用于致谢)

## 响应时间

- **确认收到**:48 小时内
- **初步评估**:7 天内
- **修复发布**:视严重程度而定
  - 严重漏洞(远程代码执行、权限提升等):7 天内
  - 中等漏洞(信息泄露、有限影响):30 天内
  - 低危问题(理论问题、需特殊条件):下一个 release

## 披露政策

我们遵循 **负责任的披露**(Responsible Disclosure)原则:

- 报告者请给我们合理的时间(通常 90 天)修复漏洞后再公开
- 在修复发布前,请勿公开漏洞细节
- 我们会在修复发布时致谢报告者(除非你希望匿名)

## 致谢

负责任地报告安全问题的人将被列入项目的致谢名单(在 Release Notes 中)。
