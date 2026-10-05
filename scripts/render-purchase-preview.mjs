import { writeFileSync, mkdirSync } from 'node:fs';
import { supporterMessage } from '../src/paynow-discord.js';
import { createPaynowGoalReader } from '../src/paynow-goal.js';

// Local visual preview generated from the same payload sent to Discord.
const goal = await createPaynowGoalReader()();
const message = supporterMessage({ customer: { minecraft: { name: 'Cerberooz' } }, lines: [{ product_name: 'SUPREME Rank' }] }, 'store.strafemc.net', null, { goal });
const embed = message.embeds[0];
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const markup = escape(embed.description)
  .replace(/&lt;:(\w+):(\d+)&gt;/g, '<img class="emoji" alt=":$1:" src="https://cdn.discordapp.com/emojis/$2.png?size=48">')
  .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  .replace(/\[Visit our store\]\(https:\/\/store.strafemc.net\/\)/g, '<a href="https://store.strafemc.net/">Visit our store</a>')
  .replace(/\n/g, '<br>');
mkdirSync('design-review', { recursive: true });
writeFileSync('design-review/purchase-embed-preview.html', `<!doctype html><html lang="en"><meta charset="utf-8"><title>StrafeMC purchase embed preview</title><style>
*{box-sizing:border-box}body{min-width:720px;margin:0;padding:36px;background:#313338;color:#dbdee1;font:16px/1.4 Arial,sans-serif}.message{display:flex;gap:16px;max-width:720px}.avatar{width:40px;height:40px;object-fit:contain;border-radius:50%;background:#232428;padding:5px}.sender{color:#8cde9f;font-weight:700;margin:0 0 8px}.bot{margin-left:7px;font-size:10px;background:#5865f2;color:white;border-radius:3px;padding:2px 4px}.time{font-size:12px;font-weight:400;color:#949ba4;margin-left:10px}.embed{width:560px;border-left:4px solid #${embed.color.toString(16)};border-radius:4px;background:#2b2d31;padding:16px}.thumbnail{float:right;width:80px;height:80px;object-fit:contain;margin:0 0 12px 18px;border-radius:4px}.title{font-size:16px;font-weight:700;color:#f2f3f5;margin-bottom:8px}.description{font-size:14px;line-height:1.45}.emoji{width:20px;height:20px;object-fit:contain;vertical-align:-5px}.footer{font-size:12px;margin-top:16px;color:#dbdee1}a{color:#00a8fc;text-decoration:none}strong{color:#f2f3f5}</style><div class="message"><img class="avatar" src="${embed.thumbnail.url}"><div><div class="sender">store.strafemc.net<span class="bot">APP</span><span class="time">Today at 18:26</span></div><div class="embed"><img class="thumbnail" src="${embed.thumbnail.url}"><div class="title">${escape(embed.title)}</div><div class="description">${markup}</div><div class="footer">${escape(embed.footer.text)}</div></div></div></div></html>`);

