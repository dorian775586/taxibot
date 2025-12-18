const { Bot, Keyboard, InlineKeyboard, session, GrammyError, HttpError } = require("grammy");
const mongoose = require("mongoose");
const http = require("http");
const dayjs = require("dayjs");
const axios = require("axios");
const cheerio = require("cheerio");
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const admin = require("firebase-admin"); // Добавлено для Firebase

// Настройка работы со временем
dayjs.extend(utc);
dayjs.extend(timezone);

// --- 🔑 ИНИЦИАЛИЗАЦИЯ FIREBASE (Для ручного управления ценами) ---
// Убедитесь, что файл serviceAccountKey.json лежит в корневой папке
try {
    const serviceAccount = require("./serviceAccountKey.json"); 
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
} catch (e) {
    console.log("⚠️ Firebase key не найден. Ручное управление ценами через Firebase будет недоступно.");
}
const dbFirestore = admin.apps.length ? admin.firestore() : null;

// --- ⚙️ НАСТРОЙКИ ---
const token = "7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o";
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";
const mongoUri = "mongodb+srv://user775586:user775586@cluster0.36spuej.mongodb.net/?appName=Cluster0"; 

// Список администраторов
const ADMIN_ID = 623203896; 
const SECOND_ADMIN_ID = 7469074713; // @hotmapfix
const ADMINS = [ADMIN_ID, SECOND_ADMIN_ID];

const bot = new Bot(token);

// --- 🗄️ БАЗА ДАННЫХ ---
mongoose.connect(mongoUri).then(() => console.log("✅ База подключена"));

const userSchema = new mongoose.Schema({
    userId: { type: Number, unique: true },
    name: { type: String, default: "Водитель" }, 
    tariff: String, 
    city: String,
    isAllowed: { type: Boolean, default: false },
    expiryDate: { type: Date, default: null }, 
    username: String,
    displayName: String, // Имя из профиля ТГ
    regDate: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

const fuelSchema = new mongoose.Schema({
    city: { type: String, unique: true },
    ai92: String, ai95: String, dt: String, gas: String, lastUpdate: Date
});
const Fuel = mongoose.model("Fuel", fuelSchema);

const Event = mongoose.model("Event", new mongoose.Schema({
    city: String, title: String, address: String, lat: Number, lng: Number, expireAt: Date
}));

// Модель для отображения машинок такси
const Taxi = mongoose.model("Taxi", new mongoose.Schema({
    city: String, lat: Number, lng: Number, expireAt: Date
}));

// Инициализация сессии (добавлен replyToUser для админов, editingCity для цен)
bot.use(session({ initial: () => ({ step: "idle", tariff: null, replyToUser: null, editingCity: null }) }));

// --- 🌐 ПАРСЕР ТОПЛИВА (Автоматический резерв) ---
async function fetchFuelPrices(cityName) {
    try {
        const cityTranslit = {
            "Москва": "moskva", "Санкт-Петербург": "sankt-peterburg", 
            "Новосибирск": "novosibirsk", "Екатеринбург": "ekaterinburg", 
            "Казань": "kazan", "Челябинск": "chelyabinsk"
        };
        const slug = cityTranslit[cityName];
        if (!slug) return null;
        const { data } = await axios.get(`https://fuelprices.ru/${slug}`, { timeout: 8000 });
        const $ = cheerio.load(data);
        const p = [];
        $(".price_table tr td").each((i, el) => p.push($(el).text().trim()));
        if (p.length > 5) {
            const fuelData = {
                city: cityName,
                ai92: p[1] || "—", ai95: p[3] || "—", dt: p[5] || "—", gas: p[7] || "—",
                lastUpdate: new Date()
            };
            await Fuel.findOneAndUpdate({ city: cityName }, fuelData, { upsert: true });
            return fuelData;
        }
    } catch (e) { return null; }
}

// --- 🚀 ЛОГИКА ГЕНЕРАЦИИ МАШИНОК (А-ЛЯ ЯНДЕКС) ---
async function generateFakeTaxis(cityName, eventPoints) {
    const taxis = [];
    const count = 15 + Math.floor(Math.random() * 10); 
    for (let i = 0; i < count; i++) {
        const basePoint = eventPoints[Math.floor(Math.random() * eventPoints.length)] || { lat: 55.75, lng: 37.61 };
        let lat = basePoint.lat + (Math.random() - 0.5) * 0.12;
        let lng = basePoint.lng + (Math.random() - 0.5) * 0.12;

        // Проверка: машинка попадает в фиолетовую зону?
        let inZone = eventPoints.some(p => {
            const dist = Math.sqrt(Math.pow(p.lat - lat, 2) + Math.pow(p.lng - lng, 2));
            return dist < 0.015; 
        });

        // Если попала в зону — в 90% случаев выталкиваем её наружу
        if (inZone && Math.random() > 0.1) {
            lat += (Math.random() > 0.5 ? 0.02 : -0.02);
            lng += (Math.random() > 0.5 ? 0.02 : -0.02);
        }

        taxis.push({ city: cityName, lat, lng, expireAt: dayjs().add(10, 'minute').toDate() });
    }
    if (taxis.length) await Taxi.insertMany(taxis);
}

// --- 🚀 ПАРСЕР КАРТЫ (ОБНОВЛЕНИЕ РАЗ В 10 МИНУТ) ---
async function updateAllCities() {
    const CITIES_MAP = {
        "msk": "Москва", "spb": "Санкт-Петербург", "kzn": "Казань", 
        "nsk": "Новосибирск", "ekb": "Екатеринбург", "che": "Челябинск"
    };
    await Event.deleteMany({});
    await Taxi.deleteMany({}); 
    let total = 0;

    for (const [slug, cityName] of Object.entries(CITIES_MAP)) {
        try {
            const url = `https://kudago.com/public-api/v1.4/events/?location=${slug}&fields=place,dates,title&page_size=25&expand=place&actual_since=${Math.floor(Date.now()/1000)}`;
            const { data } = await axios.get(url);
            const events = data.results.filter(i => i.place?.coords).map(i => ({
                city: cityName, title: i.title, address: i.place.address,
                lat: i.place.coords.lat, lng: i.place.coords.lon,
                expireAt: dayjs().add(10, 'minute').toDate()
            }));
            
            if (events.length > 0) { 
                await Event.insertMany(events); 
                await generateFakeTaxis(cityName, events);
                total += events.length; 
            }
        } catch (e) { console.log("Ошибка обновления " + cityName); }
    }
    return total;
}

// Автообновление каждые 10 минут
setInterval(updateAllCities, 600000);

// --- 🛠️ КЛАВИАТУРЫ ---
function getMainKeyboard(userId) {
    const kb = new Keyboard()
        .text("Открыть карту 🔥").text("Буст аккаунта ⚡️").row() // Карта и Буст сверху в одном ряду
        .text("Цены на топливо ⛽️").text("Мой профиль 👤").row()
        .text("Анализ аккаунта 🔍").row()
        .text("Техподдержка 🆘"); // Кнопка техподдержки

    if (ADMINS.includes(userId)) {
        kb.row().text("Аналитика 📊").text("Список водителей 📋").row().text("Обновить карту 🔄");
    }
    return kb.resized();
}

function getCitiesKeyboard() {
    const kb = new InlineKeyboard();
    ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Челябинск"].forEach((c, i) => {
        kb.text(c, `regcity_${c}`);
        if ((i + 1) % 2 === 0) kb.row();
    });
    return kb;
}

// --- 🤖 ЛОГИКА ---
bot.command("start", async (ctx) => {
    let user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        ctx.session.step = "wait_tariff";
        return ctx.reply("🚕 Добро пожаловать! Выберите тариф:", { 
            reply_markup: new Keyboard().text("Эконом").text("Комфорт").row().text("Комфорт+").text("Элит").resized().oneTime() 
        });
    }

    const status = (user.isAllowed && user.expiryDate > new Date()) ? "🟢 Активен" : "🔴 Доступ закрыт";
    await ctx.reply(`🏠 **Главное меню**\nСтатус: ${status}`, { reply_markup: getMainKeyboard(ctx.from.id), parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Редактирование цен для админа
    if (data.startsWith("edit_fuel_")) {
        const city = data.split("_")[2];
        ctx.session.step = "edit_fuel_input";
        ctx.session.editingCity = city;
        await ctx.answerCallbackQuery();
        return ctx.reply(`📝 Введите новые цены для города **${city}** в одну строку через пробел (92 95 ДТ Газ).\nПример: \`52.50 58.30 62.00 28.50\``);
    }

    // Обработка кнопки "Ответить" для админов
    if (data.startsWith("reply_")) {
        const targetId = data.split("_")[1];
        ctx.session.replyToUser = targetId;
        await ctx.answerCallbackQuery();
        return ctx.reply(`✍️ Введите сообщение для ответа водителю (ID: ${targetId}):`);
    }

    if (data === "accept_analysis") {
        ctx.session.step = "wait_phone";
        return ctx.editMessageText("📞 Пожалуйста, введите ваш контактный номер телефона для связи со специалистом техподдержки:");
    }

    if (data === "cancel_analysis") {
        return ctx.editMessageText("🏠 Вы вернулись в меню. Выберите нужный раздел.");
    }

    if (data.startsWith("regcity_")) {
        const city = data.split("_")[1];
        const count = await User.countDocuments();
        const user = new User({
            userId: ctx.from.id, 
            username: ctx.from.username || "—",
            displayName: ctx.from.first_name || "Без имени",
            tariff: ctx.session.tariff, 
            city: city,
            name: `Водитель #${count + 1}`, 
            isAllowed: false
        });
        await user.save();
        ctx.session.step = "idle";
        await ctx.editMessageText(`✅ Заявка отправлена!\nID: ${user.name}\nГород: ${city}\n\nОжидайте активации админом.`);
        ADMINS.forEach(adminId => {
            bot.api.sendMessage(adminId, `🔔 Новая заявка: ${user.name} (@${ctx.from.username || 'нет юзернейма'})`);
        });
    }

    if (!ADMINS.includes(ctx.from.id)) return;

    if (data.startsWith("manage_")) {
        const tid = data.split("_")[1];
        const u = await User.findOne({ userId: tid });
        const exp = u.expiryDate ? dayjs(u.expiryDate).format("DD.MM.YYYY") : "—";
        const tgLink = u.username !== "—" ? `@${u.username}` : (u.displayName || "Скрыто");

        const kb = new InlineKeyboard()
            .text("✅ Доступ (31д)", `allow_${tid}`)
            .text("🚫 Блок", `block_${tid}`).row()
            .text("🗑 Удалить", `delete_${tid}`).row()
            .text("⬅️ Назад", "back_to_list");

        await ctx.editMessageText(`👤 **${u.name || 'Водитель'}**\nТГ: ${tgLink}\nГород: ${u.city}\nДоступ: ${u.isAllowed ? "Да" : "Нет"}\nИстекает: ${exp}`, { reply_markup: kb, parse_mode: "Markdown" });
    }

    if (data === "back_to_list") {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        await ctx.editMessageText("👥 Список водителей:", { reply_markup: kb });
    }

    if (data.startsWith("allow_") || data.startsWith("block_")) {
        const [act, tid] = data.split("_");
        const ok = act === "allow";
        await User.findOneAndUpdate({ userId: tid }, { isAllowed: ok, expiryDate: ok ? dayjs().add(31, 'day').toDate() : null });
        ctx.answerCallbackQuery("Выполнено");
        await bot.api.sendMessage(tid, ok ? "✅ Доступ одобрен на 31 день!" : "❌ Доступ ограничен.");
        
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        return ctx.editMessageText("✅ Статус обновлен. Список:", { reply_markup: kb });
    }

    if (data.startsWith("delete_")) {
        await User.findOneAndDelete({ userId: data.split("_")[1] });
        ctx.answerCallbackQuery("Удален");
        await ctx.editMessageText("🗑 Удалено.");
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.msg.text;
    const userId = ctx.from.id;
    const user = await User.findOne({ userId });

    // Обработка ввода новых цен (Админ)
    if (ctx.session.step === "edit_fuel_input" && ADMINS.includes(userId)) {
        const prices = text.split(" ");
        if (prices.length < 4) return ctx.reply("❌ Ошибка! Введите 4 значения через пробел.");
        
        if (dbFirestore) {
            await dbFirestore.collection("fuel").doc(ctx.session.editingCity).set({
                ai92: prices[0], ai95: prices[1], dt: prices[2], gas: prices[3], lastUpdate: new Date()
            });
        }
        await Fuel.findOneAndUpdate({ city: ctx.session.editingCity }, {
            ai92: prices[0], ai95: prices[1], dt: prices[2], gas: prices[3], lastUpdate: new Date()
        }, { upsert: true });

        ctx.session.step = "idle";
        return ctx.reply(`✅ Цены для города **${ctx.session.editingCity}** обновлены!`);
    }

    // Логика ответа админа водителю
    if (ADMINS.includes(userId) && ctx.session.replyToUser) {
        const targetId = ctx.session.replyToUser;
        try {
            await bot.api.sendMessage(targetId, `📩 **Сообщение от техподдержки:**\n\n${text}`, { parse_mode: "Markdown" });
            await ctx.reply(`✅ Ответ отправлен водителю (ID: ${targetId})`);
        } catch (e) {
            await ctx.reply("❌ Не удалось отправить сообщение. Возможно, пользователь заблокировал бота.");
        }
        ctx.session.replyToUser = null;
        return;
    }

    // Логика приема сообщения в техподдержку
    if (ctx.session.step === "wait_support") {
        ctx.session.step = "idle";
        const supportMsg = `🆘 **НОВОЕ ОБРАЩЕНИЕ В ПОДДЕРЖКУ**\n\n` +
                           `👤 **Водитель:** ${user?.name || 'Неизвестно'}\n` +
                           `🏙 **Город:** ${user?.city || '—'}\n` +
                           `🚕 **Тариф:** ${user?.tariff || '—'}\n` +
                           `🔗 **TG:** @${ctx.from.username || 'нет'}\n` +
                           `🆔 **User ID:** ${userId}\n\n` +
                           `💬 **Сообщение:** ${text}`;

        for (const adminId of ADMINS) {
            await bot.api.sendMessage(adminId, supportMsg, { 
                reply_markup: new InlineKeyboard().text("Ответить 💬", `reply_${userId}`) 
            });
        }

        return ctx.reply("✅ Ваше обращение принято и передано специалистам. Мы ответим вам в этом чате в ближайшее время.\n\n" +
                         "⚠️ *Если вы не получили ответа в течение 60 минут, пожалуйста, напишите нам напрямую:* @hotmapfix", { parse_mode: "Markdown" });
    }

    if (ctx.session.step === "wait_phone") {
        ctx.session.step = "idle";
        await ctx.reply("✅ Ваша заявка принята! Специалист свяжется с вами в ближайшее время.");
        ADMINS.forEach(adminId => {
            bot.api.sendMessage(adminId, `🚀 **НОВАЯ ЗАЯВКА НА АНАЛИЗ**\n\n👤 Имя: ${user?.name || 'Неизвестно'}\n📍 Город: ${user?.city || '—'}\n📞 Номер: ${text}\n🔗 ТГ: @${ctx.from.username || 'нет'}`);
        });
        return;
    }

    if (text === "Открыть карту 🔥") {
        if (ADMINS.includes(userId) || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("📍 Карта готова:", { reply_markup: new InlineKeyboard().webApp("Запустить", `${webAppUrl}?city=${encodeURIComponent(user?.city || 'Москва')}`) });
        }
        return ctx.reply("🚫 Нет доступа.");
    }

    if (text === "Буст аккаунта ⚡️") {
        if (ADMINS.includes(userId) || (user?.isAllowed && user.expiryDate > new Date())) {
            return ctx.reply("⚡️ Система ускорения заказов:", { 
                reply_markup: new InlineKeyboard().webApp("Запустить Буст", `${webAppUrl}?page=boost&id=${user?.name || 'Driver'}`) 
            });
        }
        return ctx.reply("🚫 Доступ к системе Буста закрыт. Обратитесь к администратору.");
    }

    if (text === "Техподдержка 🆘") {
        ctx.session.step = "wait_support";
        return ctx.reply("👋 **Здравствуйте!**\n\nЕсли вы столкнулись с технической неисправностью, ошибкой в работе карты или системы «Буст», пожалуйста, напишите максимально подробно, что именно произошло. Мы изучим ваше обращение и ответим прямо здесь.", { reply_markup: { remove_keyboard: true } });
    }

    if (text === "Анализ аккаунта 🔍") {
        const kb = new InlineKeyboard()
            .text("✅ Согласен", "accept_analysis")
            .text("❌ Отмена", "cancel_analysis");
        return ctx.reply("📈 Вы можете заказать анализ своего аккаунта на предмет теневых ограничений ЯндексGo (теневой бан), проверки уровня коэффициента и получения комплексных рекомендаций от специалиста технической службы Яндекс.", { reply_markup: kb });
    }

    if (text === "Цены на топливо ⛽️") {
        if (!user) return;
        
        // Пытаемся взять данные из Firebase (если настроено) или MongoDB
        let f = null;
        if (dbFirestore) {
            const doc = await dbFirestore.collection("fuel").doc(user.city).get();
            if (doc.exists) f = doc.data();
        }
        if (!f) f = await Fuel.findOne({ city: user.city });
        if (!f) f = await fetchFuelPrices(user.city);
        
        if (!f) return ctx.reply("❌ Данные временно отсутствуют.");

        const kb = new InlineKeyboard();
        if (ADMINS.includes(userId)) {
            kb.text("Изменить цены 📝", `edit_fuel_${user.city}`);
        }

        return ctx.reply(`⛽️ **Цены ${user.city}:**\n92: ${f.ai92}р\n95: ${f.ai95}р\nДТ: ${f.dt}р\nГаз: ${f.gas}р`, { 
            parse_mode: "Markdown",
            reply_markup: kb
        });
    }

    if (text === "Мой профиль 👤") {
        if (!user) return;
        const exp = user.expiryDate ? dayjs(user.expiryDate).format("DD.MM.YYYY") : "Нет";
        return ctx.reply(`👤 **Профиль:**\nID: ${user.name}\nГород: ${user.city}\nДоступ до: ${exp}`, { parse_mode: "Markdown" });
    }

    if (text === "Аналитика 📊" && ADMINS.includes(userId)) {
        const uCount = await User.countDocuments();
        const eCount = await Event.countDocuments();
        const tCount = await Taxi.countDocuments();
        return ctx.reply(`📊 **Статистика:**\nВодителей: ${uCount}\nТочек на карте: ${eCount}\nМашинок такси: ${tCount}`);
    }

    if (text === "Список водителей 📋" && ADMINS.includes(userId)) {
        const users = await User.find().sort({ regDate: -1 }).limit(30);
        const kb = new InlineKeyboard();
        users.forEach(u => kb.text(`${u.isAllowed ? "🟢" : "🔴"} ${u.name || u.userId}`, `manage_${u.userId}`).row());
        return ctx.reply("👥 Список водителей:", { reply_markup: kb });
    }

    if (text === "Обновить карту 🔄" && ADMINS.includes(userId)) {
        await ctx.reply("📡 Обновляю точки и машинки...");
        const count = await updateAllCities();
        return ctx.reply(`✅ Карта обновлена! Добавлено зон: ${count}`);
    }

    if (ctx.session.step === "wait_tariff") {
        ctx.session.tariff = text;
        ctx.session.step = "idle";
        return ctx.reply("🏙 Выберите город:", { reply_markup: getCitiesKeyboard() });
    }
});

bot.catch((err) => console.error(err));
bot.start();

// --- API СЕРВЕР ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (req.url.startsWith('/api/points') || req.url.startsWith('/api/data')) {
        const city = url.searchParams.get('city');
        const filter = (city && city !== "undefined" && city !== "null") ? { city } : {};
        
        const events = await Event.find(filter);
        const taxis = await Taxi.find(filter);
        
        res.end(JSON.stringify({
            events: events,
            taxis: taxis
        }));
    } else {
        res.end(JSON.stringify({ status: "running" }));
    }
});

server.listen(process.env.PORT || 8080);