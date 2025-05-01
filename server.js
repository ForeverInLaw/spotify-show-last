require('dotenv').config(); // Загрузка переменных из .env
const express = require('express');
const fetch = require('node-fetch'); // или import axios from 'axios';
const cors = require('cors');
const querystring = require('querystring');

const app = express();
const port = process.env.PORT || 3000; // Порт для Heroku

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
let refreshToken = process.env.SPOTIFY_REFRESH_TOKEN; // Будет обновляться
const frontendUri = process.env.FRONTEND_URI;
console.log("CORS Middleware: Разрешенный origin (frontendUri):", frontendUri);

// Разрешаем запросы с вашего сайта на GitHub Pages
app.use(cors({ origin: frontendUri }));

// --- Шаг 1: Получение Refresh Token (нужно сделать один раз вручную) ---
// Эндпоинт для старта авторизации (перейдите сюда в браузере ОДИН РАЗ)
app.get('/login', (req, res) => {
    const scope = 'user-read-currently-playing'; // Права доступа
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            redirect_uri: redirectUri,
        }));
});

// Эндпоинт, куда Spotify перенаправит после авторизации
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;

    const authOptions = {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: querystring.stringify({
            code: code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        })
    };

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
        const data = await response.json();

        if (response.ok) {
            const access_token = data.access_token;
            refreshToken = data.refresh_token; // <-- ВАЖНО: Сохраните этот токен!
            console.log("ПОЛУЧЕН REFRESH TOKEN:", refreshToken);
            res.send(`Успешно! Ваш Refresh Token: ${refreshToken}. <br>Теперь добавьте его в переменную окружения SPOTIFY_REFRESH_TOKEN на Heroku и перезапустите приложение.`);
            // В реальном приложении токен нужно безопасно сохранить (БД или переменные окружения Heroku)
            // **Не забудьте добавить его в .env локально и в Config Vars на Heroku!**
        } else {
            res.status(response.status).send(`Ошибка получения токена: ${data.error_description || 'Неизвестная ошибка'}`);
        }
    } catch (error) {
        console.error("Ошибка при обмене кода на токен:", error);
        res.status(500).send("Внутренняя ошибка сервера при обмене кода.");
    }
});

// --- Шаг 2: Получение Access Token с помощью Refresh Token ---
async function getAccessToken() {
    if (!refreshToken) {
        console.error("Refresh Token не установлен!");
        throw new Error("Refresh Token не найден. Пройдите авторизацию через /login.");
    }
    const authOptions = {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })
    };

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
        const data = await response.json();
        if (!response.ok) {
             // Если refresh token невалиден, возможно, нужно снова пройти /login
             console.error("Ошибка обновления токена:", data);
             throw new Error(data.error_description || "Не удалось обновить токен");
        }
         // Spotify может вернуть новый refresh token, но не всегда. Обычно старый продолжает работать.
        // if (data.refresh_token) {
        //     refreshToken = data.refresh_token;
        //     // TODO: Обновить сохраненный refresh token (в переменных окружения Heroku)
        //     console.log("Получен новый refresh token (необходимо обновить в Config Vars!)");
        // }
        return data.access_token;
    } catch (error) {
        console.error("Ошибка при получении access token:", error);
        throw error; // Передаем ошибку дальше
    }
}

// --- Шаг 3: API Эндпоинт для Фронтенда ---
app.get('/api/now-playing', async (req, res) => {
    try {
        const accessToken = await getAccessToken();
        const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });

        // Spotify возвращает 204 No Content, если ничего не играет
        if (response.status === 204 || response.status > 400) {
            return res.json({ isPlaying: false });
        }

        const song = await response.json();

         // Проверяем, что ответ содержит ожидаемые данные и item не null
        if (!song || !song.item) {
            return res.json({ isPlaying: false });
        }

        const trackData = {
            isPlaying: song.is_playing,
            title: song.item.name,
            artist: song.item.artists.map(artist => artist.name).join(', '),
            albumImageUrl: song.item.album.images[0]?.url, // Берем самую большую обложку
            songUrl: song.item.external_urls.spotify,
            previewUrl: song.item.preview_url, // URL для 30-секундного превью
            trackId: song.item.id // ID трека для embed-виджета
        };
        res.json(trackData);

    } catch (error) {
        console.error("Ошибка в /api/now-playing:", error);
        // Отправляем информацию об ошибке на фронтенд (опционально)
        // или просто статус, что что-то пошло не так
        res.status(500).json({ isPlaying: false, error: error.message || "Ошибка получения данных из Spotify" });
    }
});

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
    if (!refreshToken) {
        console.warn("!!! Refresh Token не найден. Перейдите на /login в браузере, чтобы авторизоваться.");
    }
     if (!frontendUri) {
        console.warn("!!! FRONTEND_URI не установлен в .env. CORS может не работать.");
    }
});
