import { relations } from "drizzle-orm";
import { orders, orderItems, articles, stockHistory, customers } from "./schema.js";

export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.orderId],
  }),
}));

export const articlesRelations = relations(articles, ({ many }) => ({
  stockHistory: many(stockHistory),
}));

export const stockHistoryRelations = relations(stockHistory, ({ one }) => ({
  article: one(articles, {
    fields: [stockHistory.articleId],
    references: [articles.id],
  }),
}));
