-- Users and group chats can now live on any messaging network, not just iMessage.
-- users.phone becomes users.address, and every id carries its network as a prefix,
-- so imessage:+15551234567 and whatsapp:+15551234567 are different users.
-- Discord ids were already prefixed; everything else in here came from iMessage.

alter table users rename column phone to address;
alter table users rename constraint users_phone_key to users_address_key;

update users set address = 'imessage:' || address where address not like 'discord:%';
update plans set group_id = 'imessage:' || group_id where group_id not like 'discord:%';
