import type { PoolClient } from 'pg';
export const inventorySql = `SELECT a.id,a.sku,a.name,a.category,a.shop_product_id,a.stock,a.is_active,a.shop_visible,
 a.selling_price,a.sale_price,a.variants,a.created_at,a.updated_at,
 (SELECT count(*)::int FROM stock_history h WHERE h.article_id=a.id) AS movement_count,
 (SELECT jsonb_build_object('type',h.change_type,'before',h.quantity_before,'change',h.quantity_change,'after',h.quantity_after,'at',h.created_at)
   FROM stock_history h WHERE h.article_id=a.id ORDER BY h.created_at DESC,h.id DESC LIMIT 1) AS last_movement
 FROM articles a ORDER BY a.id LIMIT 5001`;
export function stockDiagnosis(article: {
    stock: number;
    movement_count: number;
    last_movement: {
        type: string;
        after: number;
        at: string;
    } | null;
}) {
    if (!article.last_movement)
        return { code: 'no_movements', message: article.stock === 0 ? 'Kein Wareneingang oder andere Bestandsbewegung dokumentiert.' : 'Bestand vorhanden; keine Bewegung dokumentiert.' };
    if (article.last_movement.after !== article.stock)
        return { code: 'history_mismatch', message: 'Aktueller Bestand weicht von der letzten dokumentierten Bewegung ab. Prüfen.' };
    if (article.stock > 0)
        return { code: 'stock_available', message: 'Bestand stimmt mit der letzten Bewegung überein.' };
    if (article.last_movement.type === 'verkauf')
        return { code: 'sold_out', message: 'Die letzte Verkaufsbuchung hat den Bestand auf 0 reduziert.' };
    if (article.last_movement.type === 'korrektur')
        return { code: 'corrected_to_zero', message: 'Die letzte Bestandskorrektur hat den Bestand auf 0 gesetzt.' };
    return { code: 'zero_after_movement', message: 'Bestand 0 stimmt mit der letzten dokumentierten Bewegung überein.' };
}
export async function readOperationsInventory(client: PoolClient) {
    const { rows } = await client.query(inventorySql);
    if (rows.length > 5000)
        throw Error('inventory_limit');
    const { rows: [clock] } = await client.query('SELECT transaction_timestamp() AS observed_at');
    return { source: '369-wawi-inventory', observedAt: clock.observed_at, complete: true, articles: rows.map(a => ({ ...a, diagnosis: stockDiagnosis(a) })) };
}
