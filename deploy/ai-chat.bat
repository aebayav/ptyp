@echo off
title PTYP AI Konsolu - SSH Tuneli
echo ============================================
echo  PTYP AI Test Konsolu
echo  Tarayicida ac:  http://localhost:8787/chat
echo  (Bu pencereyi kapatirsan baglanti kopar)
echo ============================================
ssh -p 33525 -o ServerAliveInterval=30 -N -L 8787:127.0.0.1:8787 turguz@turguz.app
pause
