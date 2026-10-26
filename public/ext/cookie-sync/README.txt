LX 音乐账号 Cookie 同步 —— 浏览器扩展
=====================================

作用：在已登录的音乐平台页面里点一下，自动读取该站点的登录 Cookie（含 HttpOnly），
直接写进你自己的 LX 服务器，不用开 F12、不用手工复制。

安装（Chrome / Edge）
---------------------
1. 把 lx-cookie-sync.zip 解压到一个固定位置（例如 D:\lx-cookie-sync），删掉就别动它。
2. 浏览器地址栏输入 chrome://extensions （Edge 是 edge://extensions）回车。
3. 右上角打开「开发者模式」。
4. 点「加载已解压的扩展程序」，选择刚解压出来的文件夹（里面有 manifest.json 那一层）。
5. 工具栏出现扩展图标后，建议点一下拼图图标把它固定出来。

使用
----
1. 先在浏览器里正常登录音乐平台（网易云 / QQ 音乐 / 酷我 / 酷狗 / 咪咕 / Bilibili）。
   酷我、咪咕建议登录后随便播一首歌，让鉴权 Cookie 下发完整。
   B 站需要大会员才有 Hi-Res / 杜比；汽水音乐本扩展不支持（见文末说明）。
2. 停留在该平台页面，点扩展图标。
3. 第一次填「服务器地址」（例如 http://192.168.1.120:8027）和「管理员密码」，
   点「一键同步到服务器」，浏览器会弹一次授权，允许即可。
4. 状态区显示「已同步 N 个 Cookie」即完成；后面会自动跑一次校验并回显结果。

也可以复制成通用格式
--------------------
点「复制为 Netscape Cookie 文件」，得到的是 curl / go-music-dl / 各种 Cookie 插件通用的
Netscape 格式文本，可以直接粘贴到 LX 后台的「填写 Cookie」输入框（服务器会自动识别），
也可以存成 cookie.txt 给 go-music-dl 用。

权限说明
--------
- 只申请了 6 个音乐站点的读取权限，用来读取你自己已登录的 Cookie。
- 服务器地址是可选授权：只有你点了同步、并在弹窗里允许之后，扩展才具备访问该地址的权限。
- 数据只发往你填写的地址，不经任何第三方。

支持平台
--------
网易云音乐 music.163.com
QQ 音乐   y.qq.com
酷我音乐  www.kuwo.cn
酷狗音乐  www.kugou.com
咪咕音乐  music.migu.cn
Bilibili  www.bilibili.com

关于汽水音乐（不在本扩展支持范围）
----------------------------------
汽水的官网 www.qishui.com 只是一个下载落地页，没有账号登录入口；浏览器里也跑不了它的播放器。
浏览器里能读到的 qishui.com 域 Cookie 只有 ttwid / odin_tt / n_mh 这类游客标识，不是登录态，
同步过去服务器会显示「未登录」，所以本扩展不再列汽水。

汽水真正有效的登录态（sessionid / sessionid_ss / sid_tt / sid_guard）只有官方 PC 客户端登录后才会下发，
存在 %APPDATA%\SodaMusic\Network\Cookies 这个 Chromium Cookie 库里，value 列是明文、不需要解密。
取法：
  1. 装官方汽水 PC 客户端，登录你的账号；
  2. 关掉客户端，把上面那个 Cookies 文件复制一份到别处（避免被占用）；
  3. 把 sessionid / sessionid_ss / sid_tt / sid_guard 四项拼成一行
     "sessionid=...; sessionid_ss=...; sid_tt=...; sid_guard=..."，
     粘到 LX 后台「平台账号 → 汽水音乐 → 填写 Cookie」；
  4. 保存后点校验，正常会显示你的昵称和会员状态。
另外提醒：汽水的会员无损和版权受限曲目取流还需要官方客户端签名（后台「汽水签名器」），
只配 Cookie 只能解决登录态，不解决整曲播放。
