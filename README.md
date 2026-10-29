# kc-skills-cli

KC 技能包安裝工具。**這個倉庫只放工具程式，不含任何付費內容。**
內容由 KC 知識庫的伺服器確認你的權限後才會傳送。

## 需求
- Node.js 18 以上（免費，nodejs.org 下載 LTS 版本）

## 使用
```bash
npx github:KCKC-TW/kc-skills-cli login      # 登入：開啟瀏覽器，核對確認碼後授權
npx github:KCKC-TW/kc-skills-cli list       # 看有哪些技能包
npx github:KCKC-TW/kc-skills-cli install ig-21
npx github:KCKC-TW/kc-skills-cli update     # 更新已安裝的技能包
```

技能會安裝到 `~/.claude/skills/`，重新開啟 Claude Code 即可使用。
同名的舊技能會先備份到 `~/.kc-skills/backup/`。

## 安全
- 工具只和 KC 知識庫的伺服器連線，不會讀取你電腦上的其他檔案。
- 登入憑證存在 `~/.kc-skills/config.json`（只有你能讀），90 天有效，可在網站「技能包」頁撤銷。
- 技能包內容僅限本人使用，禁止轉售、轉贈或公開散布。
