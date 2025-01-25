import axios from "axios";
import { errorSnapshot } from "./error";
import { Span } from "@opentelemetry/api";

export type SgOrder = {
    id: string;
    owner: string;
    orderHash: string;
    orderBytes: string;
    active: boolean;
    nonce: string;
    orderbook: {
        id: string;
    };
    inputs: {
        balance: string;
        vaultId: string;
        token: {
            address: string;
            decimals: string | number;
            symbol: string;
        };
    }[];
    outputs: {
        balance: string;
        vaultId: string;
        token: {
            address: string;
            decimals: string | number;
            symbol: string;
        };
    }[];
};

export type NewSgOrder = {
    order: SgOrder;
    timestamp: number;
};

export type SgTx = {
    events: SgEvent[];
    timestamp: string;
};

export type SgEvent = SgAddRemoveEvent | SgOtherEvent;

export type SgAddRemoveEvent = {
    __typename: "AddOrder" | "RemoveOrder";
    order: SgOrder;
};

export type SgOtherEvent = {
    __typename: "Withdrawal" | "Deposit";
};

/**
 * Method to get the subgraph query body with optional filters
 * @param orderHash - The order hash to apply as filter
 * @param owner - The order owner to apply as filter
 * @param orderbook - The orderbook address
 * @returns the query string
 */
export function getQueryPaginated(
    skip: number,
    orderHash?: string,
    owner?: string,
    orderbook?: string,
): string {
    const ownerFilter = owner ? `, owner: "${owner.toLowerCase()}"` : "";
    const orderHashFilter = orderHash ? `, orderHash: "${orderHash.toLowerCase()}"` : "";
    const orderbookFilter = orderbook ? `, orderbook: "${orderbook.toLowerCase()}"` : "";
    return `{
    orders(first: 100, skip: ${skip}, orderBy: timestampAdded, orderDirection: desc, where: {active: true${orderbookFilter}${orderHashFilter}${ownerFilter}}) {
        id
        owner
        orderHash
        orderBytes
        active
        nonce
        orderbook {
            id
        }
        inputs {
            balance
            vaultId
            token {
                address
                decimals
                symbol
            }
        }
        outputs {
            balance
            vaultId
            token {
                address
                decimals
                symbol
            }
        }
    }
}`;
}

/**
 * Get all active orders from a subgraph, with optional filters
 * @param subgraph - Subgraph url
 * @param orderHash - orderHash filter
 * @param owner - owner filter
 * @param orderbook - orderbook filter
 * @param timeout - timeout
 */
export async function querySgOrders(
    subgraph: string,
    orderHash?: string,
    owner?: string,
    orderbook?: string,
    timeout?: number,
): Promise<SgOrder[]> {
    const result: any[] = [];
    let skip = 0;
    for (;;) {
        const res = await axios.post(
            subgraph,
            {
                query: getQueryPaginated(skip, orderHash, owner, orderbook),
            },
            { headers: { "Content-Type": "application/json" }, timeout },
        );
        if (res?.data?.data?.orders?.length) {
            const orders = res.data.data.orders;
            result.push(...orders);
            if (orders.length < 100) {
                break;
            } else {
                skip += 100;
            }
        } else {
            break;
        }
    }
    return result;
}

export const orderbooksQuery = `{
    orderbooks {
        id
    }
}`;

export const statusCheckQuery = `{
    _meta {
        hasIndexingErrors
        block {
            number
        }
    }
}`;

/**
 * Get query for transactions
 */
export const getTxsQuery = (start: number, skip: number) => {
    return `{transactions(
    orderBy: timestamp
    orderDirection: asc
    first: 100
    skip: ${skip}
    where: { timestamp_gt: "${start}" }
  ) {
    events {
        __typename
        ... on AddOrder {
            transaction {
                timestamp
            }
            order {
                id
                owner
                orderHash
                orderBytes
                active
                nonce
                orderbook {
                    id
                }
                inputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
                outputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
            }
        }
        ... on RemoveOrder {
            transaction {
                timestamp
            }
            order {
                id
                owner
                orderHash
                orderBytes
                active
                nonce
                orderbook {
                    id
                }
                inputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
                outputs {
                    balance
                    vaultId
                    token {
                        address
                        decimals
                        symbol
                    }
                }
            }
        }
    }
    timestamp
}}`;
};

/**
 * Fecthes the order changes after the given time and skipping the first skip txs
 * @param subgraph - The subgraph url
 * @param startTimestamp - start timestamp range
 * @param skip - skip count
 * @param timeout - promise timeout
 */
export async function getOrderChanges(
    subgraph: string,
    startTimestamp: number,
    skip: number,
    // timeout?: number,
    span?: Span,
) {
    // timeout;
    let skip_ = skip;
    let count = 0;
    const allResults: SgTx[] = [];
    const addOrders: NewSgOrder[] = [];
    const removeOrders: NewSgOrder[] = [];
    for (;;) {
        try {
            const res = await axios.post(
                subgraph,
                { query: getTxsQuery(startTimestamp, skip_) },
                { headers: { "Content-Type": "application/json" } },
            );
            if (typeof res?.data?.data?.transactions !== "undefined") {
                const txs = res.data.data.transactions;
                count += txs.length;
                allResults.push(...txs);
                if (txs.length < 100) {
                    break;
                } else {
                    skip_ += 100;
                }
            } else {
                break;
            }
        } catch (error) {
            span?.addEvent(errorSnapshot(`Failed to get orders changes ${subgraph}`, error));
            throw error;
        }
    }
    allResults.forEach((tx) => {
        if (tx?.events?.length) {
            tx.events.forEach((event) => {
                if (event.__typename === "AddOrder") {
                    if (typeof event?.order?.active === "boolean" && event.order.active) {
                        if (!addOrders.find((e) => e.order.id === event.order.id)) {
                            addOrders.push({
                                order: event.order as SgOrder,
                                timestamp: Number(tx.timestamp),
                            });
                        }
                    }
                }
                if (event.__typename === "RemoveOrder") {
                    if (typeof event?.order?.active === "boolean" && !event.order.active) {
                        if (!removeOrders.find((e) => e.order.id === event.order.id)) {
                            removeOrders.push({
                                order: event.order as SgOrder,
                                timestamp: Number(tx.timestamp),
                            });
                        }
                    }
                }
            });
        }
    });
    return { addOrders, removeOrders, count };
}
