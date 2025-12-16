const { Bot, InlineKeyboard } = require("grammy");

// Вставь сюда токен, который дал BotFather
const bot = new Bot("7973955726:AAFpMltfoqwO902Q1su5j6HWipPxEJYM3-o");

// Ссылка на твое развернутое приложение (Firebase/Vercel)
const webAppUrl = "https://hotmaptaxi-git-main-dorians-projects-14978635.vercel.app";

bot.command("start", async (ctx) => {
  // Создаем красивую кнопку под сообщением
  const keyboard = new InlineKeyboard()
    .webApp("Открыть карту 🔥", webAppUrl);

  await ctx.reply(
    `Привет, ${ctx.from.first_name}! \n\nЯ помогу тебе найти самые горячие точки на карте. Нажми кнопку ниже, чтобы начать!`,
    { reply_markup: keyboard }
  );
});

// Запуск бота
bot.start();
console.log("Бот запущен...");