package Actions {
    doc /* アクションフローのサンプル。 */

    item def Order;
    item def Product;

    action def ProcessOrder {
        in item order : Order;
        out item product : Product;

        action validate {
            in item order = ProcessOrder::order;
        }
        action manufacture;
        action ship {
            out item product;
        }

        first validate then manufacture;
        first manufacture then ship;

        flow of Order from validate to manufacture;
    }
}
