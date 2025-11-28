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
const frontendUri = process.env.FRONTEND_URI || "";
// Разбиваем строку по запятой и удаляем лишние пробелы, создавая массив
const allowedOrigins = frontendUri.split(',').map(url => url.trim());

console.log("CORS Middleware: Разрешенные домены:", allowedOrigins);

app.use(cors({
    origin: function (origin, callback) {
        // Разрешаем запросы без origin (например, server-to-server или curl)
        if (!origin) return callback(null, true);

        // Проверяем, есть ли origin в нашем списке разрешенных
        if (allowedOrigins.indexOf(origin) === -1) {
            var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
}));


// --- Шаг 1: Получение Refresh Token (нужно сделать один раз вручную) ---
// Эндпоинт для старта авторизации (перейдите сюда в браузере ОДИН РАЗ)
app.get('/login', (req, res) => {
    const scope = 'user-read-currently-playing user-read-recently-played playlist-read-private';
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

        // 1. Проверяем текущий трек
        const currentResponse = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });

        if (currentResponse.status === 200) {
            const song = await currentResponse.json();
            if (song && song.item && song.is_playing) {
                // Если что-то играет СЕЙЧАС, возвращаем это
                console.log("Сейчас играет:", song.item.name);
                const trackData = {
                    isPlaying: true, // Флаг, что трек играет прямо сейчас
                    title: song.item.name,
                    artist: song.item.artists.map(artist => artist.name).join(', '),
                    albumImageUrl: song.item.album.images[0]?.url,
                    songUrl: song.item.external_urls.spotify,
                    trackId: song.item.id
                };
                return res.json(trackData);
            }
        } else if (currentResponse.status !== 204) {
            // Если не 200 и не 204 (нет контента), значит была ошибка
            console.error("Ошибка при запросе currently-playing:", currentResponse.status, await currentResponse.text());
            // Можно сразу вернуть ошибку, или попробовать получить недавний трек
        }

        // 2. Если ничего не играет СЕЙЧАС, запрашиваем последний проигранный
        console.log("Ничего не играет, запрашиваем недавние треки...");
        const recentResponse = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=5', {
            headers: { 'Authorization': 'Bearer ' + accessToken }
        });

        if (recentResponse.status === 200) {
            const recentData = await recentResponse.json();
            if (recentData && recentData.items && recentData.items.length > 0) {
                console.log("Недавние треки (до 5):", recentData.items.map(item => item.track.name));

                const lastTrack = recentData.items[0].track;

                console.log("Последний трек:", lastTrack.name);
                const trackData = {
                    isPlaying: false, // Флаг, что трек НЕ играет сейчас (это последний)
                    title: lastTrack.name,
                    artist: lastTrack.artists.map(artist => artist.name).join(', '),
                    albumImageUrl: lastTrack.album.images[0]?.url,
                    songUrl: lastTrack.external_urls.spotify,
                    trackId: lastTrack.id
                };
                return res.json(trackData);
            }
        } else {
            console.error("Ошибка при запросе recently-played:", recentResponse.status, await recentResponse.text());
        }

        // 3. Если не нашли ни текущий, ни последний трек
        console.log("Не найдено ни текущих, ни недавних треков.");
        return res.json({ isPlaying: false }); // Отправляем isPlaying: false, фронтенд покажет "ничего не играет"
    } catch (error) {
        console.error("Ошибка в /api/now-playing:", error);
        res.status(500).json({ isPlaying: false, error: error.message || "Ошибка получения данных из Spotify" });
    }
});

// --- Кэширование плейлистов ---
let playlistsCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 час

const CURATED_PLAYLIST_IDS = [
    '0Ne5hkctsl5Iw7qelG880O', // wave/hardwave
    '1rJx32q5gJBlErYiNY4MEW', // dissociation in sorrow
    '2hiCOKHVrOR6C3DlZu8YSR', // energetic dnb
    '4CdR4U4H0mNVN71laSoK02', // witch house
    '0BSI9m9B0hXR4MZyIM8El3'  // breakcore
];

app.get('/api/playlists', async (req, res) => {
    try {
        // Проверка кэша
        if (playlistsCache && (Date.now() - lastCacheTime < CACHE_DURATION)) {
            console.log("Отдача плейлистов из кэша");
            return res.json(playlistsCache);
        }

        console.log("Запрос плейлистов из Spotify API...");
        const accessToken = await getAccessToken();

        const playlistPromises = CURATED_PLAYLIST_IDS.map(async (id) => {
            try {
                const response = await fetch(`https://api.spotify.com/v1/playlists/${id}`, {
                    headers: { 'Authorization': 'Bearer ' + accessToken }
                });

                if (!response.ok) {
                    console.error(`Не удалось получить плейлист ${id}: ${response.status}`);
                    return null;
                }

                const data = await response.json();
                return {
                    id: data.id,
                    name: data.name,
                    description: data.description,
                    url: data.external_urls.spotify,
                    image: data.images[0]?.url,
                    tracks: data.tracks.total,
                    owner: data.owner.display_name
                };
            } catch (err) {
                console.error(`Ошибка получения плейлиста ${id}:`, err);
                return null;
            }
        });

        const playlists = (await Promise.all(playlistPromises)).filter(p => p !== null);

        if (playlists.length > 0) {
            playlistsCache = playlists;
            lastCacheTime = Date.now();
            res.json(playlists);
        } else {
            res.status(500).json({ error: "Не удалось получить ни одного плейлиста" });
        }

    } catch (error) {
        console.error("Ошибка в /api/playlists:", error);
        res.status(500).json({ error: error.message });
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
