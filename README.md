# 地图编辑器（Web）

纯 Web 版本。
前端运行在浏览器中，后端基于 Python Flask。

## 功能

- 2D 地图编辑视图（放置、拖拽、复制、删除）
- 实时 3D 预览视图（Three.js + GLB）
- 对象属性编辑与 JSON 保存
- 兼容现有的 objects.json 结构
- 跨平台运行（Windows、Linux、macOS）

## 安装

```bash
pip install -r requirements.txt
```

## 运行

在当前目录执行：

```bash
python web_main.py
```

浏览器打开：

```text
http://127.0.0.1:8787
```

可选参数：

```bash
python web_main.py --map ../../map.png --objects ../../objects.json --models ../../models --host 0.0.0.0 --port 8787
```
