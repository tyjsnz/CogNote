@echo off
chcp 65001 >nul
title 知识库智能体
cd /d %~dp0
echo ========================================
echo   知识库智能体 启动中...
echo   浏览器访问: http://127.0.0.1:8570
echo   关闭本窗口即停止服务
echo ========================================
node server.js
pause
